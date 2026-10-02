/**
 * The account-side half of the growth dashboard's seed — pure data, no infra.
 *
 * Three panels read the acquisition table joined to accounts by creation week
 * rather than any growth table: the cohort grid, the self-reported sources
 * panel, and the identified rungs of the funnel ladder. The growth tables those
 * screens share are rollup OUTPUT, which is why nothing writes them directly;
 * accounts and their acquisition rows are SOURCE data, and writing source data
 * is what a seed is for.
 *
 * This module chooses who signed up, when, under which campaign, on what
 * platform, what they answered when asked where they heard about us, and who
 * paid. The producer it is handed to registers each one through the real
 * registration settlement, so the acquisition row is written by registration
 * itself rather than inserted beside it.
 *
 * DETERMINISM is relative to the run day — the contract the persona, public
 * statistics and growth seeds already make. Every instant and every choice is a
 * pure function of the account's own UTC day, and the newest day a plan names is
 * the run day's own midnight, which has begun whatever instant the seed runs at.
 * So two runs on one day plan the same accounts at the same instants, which is
 * what makes a re-run a no-op: the account rows are keyed by their email and the
 * backdated instant is rewritten to the value it already holds.
 */

import {
  ACQUISITION_PLATFORMS,
  DEV_EMAIL_DOMAIN,
  GROWTH_CHANNELS,
  GROWTH_DIRECT_CAMPAIGN,
  type AcquisitionPlatform,
  type GrowthChannel,
  type GrowthSelfReportContext,
} from '@hushbox/shared';

import { GROWTH_SEED_CAMPAIGNS } from './growth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nano-USD (1e-9 USD) per whole USD. */
const NANO_USD_PER_USD = 1_000_000_000n;

/**
 * How many days back the plan reaches. The cohort grid, the ladder and the
 * sources panel all span twelve weeks from the Monday of the week the reader is
 * standing in, so the oldest account has to sit at least that far back.
 */
export const GROWTH_COHORT_DAYS = 84;

/**
 * How many days apart two consecutive signups are. A step rather than a
 * per-week count so the plan needs no week arithmetic of its own: the views
 * bucket by `date_trunc('week', …, 'UTC')` and a second Monday rule here would
 * be a spelling of theirs that could drift from it.
 *
 * The days the step admits are chosen off the absolute day number rather than
 * counted back from the run day, so the grid a run picks from is the same grid
 * every other run picks from: a run a day later drops the oldest account and
 * adds a newer one, instead of naming a whole interleaved population beside the
 * one already seeded.
 */
const GROWTH_COHORT_DAY_STEP = 2;

/**
 * The campaigns a seeded account may carry: the direct sentinel the migration
 * already seeded, plus the tags the growth seed mints. Taken from that seed
 * rather than respelled — an acquisition row's campaign is a foreign key, so a
 * tag this module invented would fail the write rather than mislabel a row.
 */
const CAMPAIGN_ROTATION: readonly string[] = [
  GROWTH_DIRECT_CAMPAIGN,
  ...GROWTH_SEED_CAMPAIGNS.map((campaign) => campaign.tag),
];

/** What one seeded account paid, and when the payment landed. */
interface GrowthCohortPayment {
  readonly at: Date;
  readonly amountNanoUsd: bigint;
}

/** One backdated turn a seeded account sent, and what it was charged for it. */
interface GrowthCohortTurn {
  readonly at: Date;
  readonly billableCostNanoUsd: bigint;
}

/** How long after signing up an account sends its first turn. */
const ACTIVATION_DAYS = 1;

/**
 * How long after signing up a returning account comes back. The ladder reads a
 * return as a turn seven days or more past the account's own instant, and this
 * sits clear of that edge so a turn is never a rounding away from the rung it
 * is meant to light.
 */
const RETURN_DAYS = 9;

/** The already-billable charge on one seeded turn. */
const TURN_COST_NANO_USD = 250_000n;

/** One seeded account, as the producer registers it. */
export interface GrowthCohortAccount {
  readonly email: string;
  /** Already in the stored form: the account column is twenty characters and the rule admits no hyphen. */
  readonly username: string;
  /** The instant the account is dated to. Midnight of its own UTC day. */
  readonly createdAt: Date;
  readonly campaign: string;
  readonly platform: AcquisitionPlatform;
  readonly emailVerified: boolean;
  /** What this account answered when asked, or null for an account that never answered. */
  readonly selfReportedChannel: GrowthChannel | null;
  /** Which of the two askings the answer came at; inert on an account that never answered. */
  readonly selfReportedContext: GrowthSelfReportContext;
  /** The first card payment, or null for an account that never paid. */
  readonly payment: GrowthCohortPayment | null;
  /**
   * The turns this account sent, oldest first, empty for an account that never
   * sent one. They are what the ladder's activated and week-one-return rungs
   * read: both ask whether a usage record names the account as its sender.
   */
  readonly usage: readonly GrowthCohortTurn[];
}

/** The member at `index`, wrapped into the list. */
function at<Value>(values: readonly Value[], index: number): Value {
  const chosen = values[index % values.length];
  /* v8 ignore next 2 -- the index is taken modulo the length, and every list here is a non-empty literal */
  if (chosen === undefined) throw new Error('growth cohort seed: an empty list has no member');
  return chosen;
}

/** Midnight of an instant's own UTC day. */
function utcMidnight(instant: Date): number {
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

/** `YYYYMMDD` — the compact day an account's stored username is built from. */
function compactDay(instant: Date): string {
  return instant.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * The day numbers the plan seeds, oldest first: the days the step admits that
 * lie inside the window, ending one step inside the run day so a payment dated
 * a few days after its account still lands on a day that has begun.
 *
 * A day number is whole days since the epoch, which is what makes a day's own
 * identity independent of when the plan was built.
 */
function dayNumbers(runDayNumber: number): readonly number[] {
  const oldest = runDayNumber - (GROWTH_COHORT_DAYS - GROWTH_COHORT_DAY_STEP);
  const newest = runDayNumber - GROWTH_COHORT_DAY_STEP;
  const days: number[] = [];
  for (let day = oldest; day <= newest; day += 1) {
    if (day % GROWTH_COHORT_DAY_STEP === 0) days.push(day);
  }
  return days;
}

/** How long after signing up a paying account paid, never past the run day. */
function paymentFor(slot: number, createdAt: Date, runDayMidnight: number): GrowthCohortPayment {
  return {
    at: new Date(Math.min(createdAt.getTime() + 3 * DAY_MS, runDayMidnight)),
    amountNanoUsd: BigInt(5 + (slot % 4) * 15) * NANO_USD_PER_USD,
  };
}

/**
 * The turns one account sent: a first turn a day after signing up for two
 * accounts in three, and a second turn nine days in for one in three — so the
 * activated rung sits below the created one and the return rung below that.
 *
 * The strides are three where the campaign rotation is four, for the reason the
 * verification stride is seven: a stride sharing a factor with the rotation
 * would put every silent account under one campaign, and that campaign's rung
 * would read zero as if the step were broken.
 *
 * An account whose ninth day has not arrived sends no second turn — the return
 * is a fact about elapsed time, and dating one into the future would invent it.
 */
function turnsFor(slot: number, createdAt: Date, runDayMidnight: number): GrowthCohortTurn[] {
  if (slot % 3 === 2) return [];
  const turns: GrowthCohortTurn[] = [
    {
      at: new Date(createdAt.getTime() + ACTIVATION_DAYS * DAY_MS),
      billableCostNanoUsd: TURN_COST_NANO_USD,
    },
  ];
  const returnAt = createdAt.getTime() + RETURN_DAYS * DAY_MS;
  if (slot % 3 === 0 && returnAt <= runDayMidnight) {
    turns.push({ at: new Date(returnAt), billableCostNanoUsd: TURN_COST_NANO_USD });
  }
  return turns;
}

/**
 * The whole account plan, oldest first.
 *
 * `now` is the instant the seed is running at, and every day derives from its
 * UTC day — which is what makes the plan deterministic for a run day and
 * nothing wider.
 */
export function buildGrowthCohortPlan(now: Date): readonly GrowthCohortAccount[] {
  const runDayMidnight = utcMidnight(now);
  return dayNumbers(runDayMidnight / DAY_MS).map((day) => {
    const createdAt = new Date(day * DAY_MS);
    // Every choice below is taken on the account's own day rather than on its
    // position in this plan: a position moves as the window slides, and an
    // account already seeded keeps whatever it was minted with, so a positional
    // choice would silently stop matching the plan that describes it.
    const slot = day / GROWTH_COHORT_DAY_STEP;
    // A minority pays, spread so every campaign in the rotation has a payer:
    // the rotation has four members and the payer stride is five, so the two
    // walk through each other rather than landing on one tag.
    const paid = slot % 5 === 1;
    // Two accounts in five never answer, so the panel's answered rate is a
    // measurement rather than a constant.
    const answered = slot % 5 < 3;
    return {
      email: `cohort-${createdAt.toISOString().slice(0, 10)}@${DEV_EMAIL_DOMAIN}`,
      username: `c${compactDay(createdAt)}`,
      createdAt,
      campaign: at(CAMPAIGN_ROTATION, slot),
      platform: at(ACQUISITION_PLATFORMS, slot),
      // Seven, where the campaign rotation is four and the answer and payment
      // strides are five: a stride sharing a factor with the rotation would put
      // every unverified account under one campaign, and that campaign's
      // verified rung would read zero as if the step were broken.
      emailVerified: slot % 7 !== 3,
      selfReportedChannel: answered ? at(GROWTH_CHANNELS, slot * 3) : null,
      selfReportedContext: paid ? 'first_payment' : 'post_signup',
      payment: paid ? paymentFor(slot, createdAt, runDayMidnight) : null,
      usage: turnsFor(slot, createdAt, runDayMidnight),
    };
  });
}

/** What a plan says it will produce, so a later reader derives its figures instead of restating them. */
interface GrowthCohortFigures {
  readonly accounts: number;
  readonly verified: number;
  readonly answered: number;
  readonly paid: number;
  readonly activated: number;
  readonly returned: number;
  readonly campaignTags: readonly string[];
}

/**
 * Whether an account came back: a second turn, which {@link turnsFor} only ever
 * dates past the week the ladder's return rung measures. A case asserts that,
 * so a third turn dated inside the first week fails rather than inflating this.
 */
function cameBack(account: GrowthCohortAccount): boolean {
  return account.usage.length > 1;
}

/** The figures a plan carries, read off the plan itself. */
export function growthCohortFigures(plan: readonly GrowthCohortAccount[]): GrowthCohortFigures {
  return {
    accounts: plan.length,
    verified: plan.filter((account) => account.emailVerified).length,
    answered: plan.filter((account) => account.selfReportedChannel !== null).length,
    paid: plan.filter((account) => account.payment !== null).length,
    activated: plan.filter((account) => account.usage.length > 0).length,
    returned: plan.filter((account) => cameBack(account)).length,
    campaignTags: [...new Set(plan.map((account) => account.campaign))].toSorted((left, right) =>
      left.localeCompare(right)
    ),
  };
}
