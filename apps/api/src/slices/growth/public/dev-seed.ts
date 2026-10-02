import { GROWTH_CEILINGS } from '@hushbox/shared';
import { GROWTH_REDIS_KEYS, growthHourBucket } from '../../../lib/redis/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { readCampaignWithinTx } from '../adapters/campaign-writes.js';
import { countBeacon } from '../domain/count-beacon.js';
import { rollupGrowthHour } from '../domain/rollup.js';
import { createCampaignWithinTx } from './campaigns.js';
import { countRegistrationStartedUnderCeiling } from '../domain/count-registration-started.js';
import type { GrowthCeilings } from '../domain/count-beacon.js';
import type { Database } from '@hushbox/db';
import type { GrowthDevice } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * Local seeding for the growth dashboard, driven through the real counting
 * path.
 *
 * The growth tables are ROLLUP OUTPUT, never source data. Writing them
 * directly would leave a broken rollup indistinguishable from a working one on
 * the very screen an operator would notice it from, so this door writes
 * nothing into them: it counts through the same pair the running system counts
 * through — the beacon writer and the registration-start counter — and then
 * runs the real reduction over the hours it wrote.
 *
 * What a seed bypasses is exactly what a seed must: the request body, the bot
 * filter, the keyed identity derivation and the campaign cache. Everything
 * past that point — per-visitor deduplication, the landing latch, the reach
 * pairs, every ceiling, the overflow flags and index membership — is the
 * production script's, because this calls it.
 *
 * Campaign rows are minted BEFORE any hour is rolled, never merely before the
 * counts are written: the funnel enumerates the database's tags and reads the
 * started set per tag, and a campaign-keyed row whose tag has no campaign
 * would fail its foreign key at write.
 *
 * A plan is counted at the instant it names, so an hour eighty days back is
 * reachable. Every counting key takes the same lifetime whatever bucket it
 * labels, so a member written now for a bucket long past is live long enough
 * to be rolled here; the rows are durable and the keys then expire on their
 * own.
 *
 * One cosmetic interaction with a Worker already running: it may hold the
 * pre-seed active-campaign list for the length of that list's own lifetime, so
 * a real visit naming a freshly seeded tag folds to the unknown sentinel
 * inside that window.
 */

/** The per-request Redis client as the pipeline types it. */
type RedisClient = Variables['redis'];

/** The infra this door writes through. */
export interface GrowthSeedDeps {
  readonly db: Database;
  readonly redis: RedisClient;
}

/** One page a seeded visitor saw, and the host it was reached from where there was one. */
export interface GrowthSeedView {
  readonly path: string;
  readonly referrerHost?: string;
}

/** One named event a seeded visitor fired on a page it was on. */
export interface GrowthSeedEvent {
  readonly path: string;
  readonly eventName: string;
}

/**
 * One seeded visitor's whole visit inside one hour. The first view is the
 * landing: the counting script claims the day's landing key from whichever
 * view arrives first, so the order here is the order the visit happened in.
 */
export interface GrowthSeedVisitor {
  /** The identity the visitor sets count, in the shape the key registry validates. */
  readonly visitor: string;
  /**
   * The address identity the mint ceiling bounds, in the shape the key
   * registry validates. It names both the mint set and its latch, which the
   * beacon derives apart; a seeded value stands for no address to keep apart.
   */
  readonly addressId: string;
  readonly campaign: string;
  readonly country: string;
  readonly region: string;
  readonly device: GrowthDevice;
  readonly views: readonly GrowthSeedView[];
  readonly events: readonly GrowthSeedEvent[];
}

/** One seeded registration start: an address that began registration under a tag. */
export interface GrowthSeedStart {
  readonly campaign: string;
  /** The day-keyed address identity the started set holds, in the shape the key registry validates. */
  readonly addressId: string;
}

/** One representative hour of seeded traffic. */
export interface GrowthSeedHour {
  readonly at: Date;
  readonly visitors: readonly GrowthSeedVisitor[];
  readonly starts: readonly GrowthSeedStart[];
}

/** A campaign the plan needs a row for before anything referencing it is rolled. */
export interface GrowthSeedCampaign {
  readonly tag: string;
  readonly label: string;
}

/** Everything one seed run counts and rolls. Hours are counted in the order given. */
export interface GrowthSeedPlan {
  readonly campaigns: readonly GrowthSeedCampaign[];
  readonly hours: readonly GrowthSeedHour[];
}

/** What one seed run amounted to. */
export interface GrowthSeedOutcome {
  /** Campaigns this run created. Zero on a re-run, whose tags all stand already. */
  readonly campaignsMinted: number;
  readonly beaconsCounted: number;
  readonly startsCounted: number;
  readonly hoursRolled: number;
  /**
   * Every set whose ceiling a member was turned away by, as its grain and the
   * set's own name. Empty is the ordinary case and the one a seed must produce:
   * a flag here says a counted figure is a floor rather than a count.
   */
  readonly overflowLatched: readonly string[];
  /**
   * How many addresses this run took the whole daily identity budget of. Zero
   * is the ordinary case; anything else says the plan concentrated its visitors
   * on too few addresses to be counted honestly.
   */
  readonly addressBudgetsFilled: number;
  /**
   * Every row whose stored landing count a re-roll had to lower to the visitors
   * this run read, as its grain, bucket and page. Empty is the ordinary case:
   * an entry cannot come from the plan, so it says the counting store lost
   * members those rows outlived — and the seed is the caller best placed to
   * notice, because it counts what it then rolls.
   */
  readonly landingsClamped: readonly string[];
}

/**
 * The value of a result, or a throw carrying the whole failure.
 *
 * The code alone names a taxonomy entry rather than a defect: a constraint the
 * database refused a row on and a dependency that never answered are both
 * `unavailable`, and the message and the error beneath it are what tell them
 * apart. Both ride out — the message in the thrown text, the failure itself as
 * the cause, whose own cause is whatever the driver raised.
 */
function valueOf<T>(result: Result<T, DomainError>, what: string): T {
  if (result.isErr()) {
    throw new Error(`growth seed: ${what} failed — ${result.error.code}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/**
 * The campaigns the plan names, minted on one transaction.
 *
 * Read first, then create: the create door answers a conflict for a tag an
 * active campaign already holds, and a seed must be able to run twice. The
 * read is on the same transaction as the write, so what it sees is what the
 * write is about to meet.
 */
async function mintCampaigns(
  tx: SettlementTx,
  wanted: readonly GrowthSeedCampaign[]
): Promise<number> {
  let minted = 0;
  for (const campaign of wanted) {
    const standing = valueOf(
      await readCampaignWithinTx(tx, campaign.tag),
      `reading campaign '${campaign.tag}'`
    );
    if (standing !== null) continue;
    valueOf(await createCampaignWithinTx(tx, campaign), `minting campaign '${campaign.tag}'`);
    minted += 1;
  }
  return minted;
}

/** One visitor's beacons in the order the visit produced them: the views, then the events. */
function beaconsOf(
  visitor: GrowthSeedVisitor,
  at: Date,
  ceilings: GrowthCeilings
): readonly Parameters<typeof countBeacon>[1][] {
  const who = {
    campaign: visitor.campaign,
    country: visitor.country,
    region: visitor.region,
    device: visitor.device,
    visitor: visitor.visitor,
    mintId: visitor.addressId,
    mintCappedId: visitor.addressId,
    at,
    ceilings,
  } as const;
  return [
    ...visitor.views.map((view) => ({
      ...who,
      kind: 'view' as const,
      path: view.path,
      referrerHost: view.referrerHost,
      eventName: undefined,
    })),
    ...visitor.events.map((event) => ({
      ...who,
      kind: 'event' as const,
      path: event.path,
      referrerHost: undefined,
      eventName: event.eventName,
    })),
  ];
}

/** Counters one run accumulates as it walks the plan. */
interface Tally {
  beaconsCounted: number;
  startsCounted: number;
  hoursRolled: number;
  addressBudgetsFilled: number;
  readonly overflowLatched: string[];
  readonly landingsClamped: string[];
}

/** Counts one hour's beacons, in the order each visit produced them. */
async function countBeacons(
  deps: GrowthSeedDeps,
  hour: GrowthSeedHour,
  ceilings: GrowthCeilings,
  tally: Tally
): Promise<void> {
  for (const visitor of hour.visitors) {
    for (const beacon of beaconsOf(visitor, hour.at, ceilings)) {
      const write = valueOf(await countBeacon(deps.redis, beacon), `counting ${beacon.path}`);
      if (write.kind === 'capped') {
        throw new Error(
          `growth seed: the daily identity budget of an address turned away a beacon for ${beacon.path}; spread the plan's visitors over more addresses`
        );
      }
      tally.beaconsCounted += 1;
      tally.overflowLatched.push(...write.overflowed);
      if (write.mintFilled) tally.addressBudgetsFilled += 1;
    }
  }
}

/** Counts one hour's registration starts through the door registration itself calls. */
async function countStarts(
  deps: GrowthSeedDeps,
  hour: GrowthSeedHour,
  ceilings: GrowthCeilings,
  tally: Tally
): Promise<void> {
  const bucket = growthHourBucket(hour.at);
  for (const start of hour.starts) {
    const latched = valueOf(
      await countRegistrationStartedUnderCeiling(
        deps.redis,
        { hour: bucket, campaign: start.campaign, addressId: start.addressId, decoy: false },
        ceilings.set
      ),
      `counting a registration start under '${start.campaign}'`
    );
    tally.startsCounted += 1;
    if (latched) {
      tally.overflowLatched.push(`h:${GROWTH_REDIS_KEYS.started.setName(start.campaign)}`);
    }
  }
}

/**
 * Seeds the growth tables through the counting path, under ceilings the caller
 * fixes.
 *
 * The parameter is what lets the bounds themselves be exercised: a thousand
 * identities from one address cannot be driven any other way, and the door
 * below is what every real seed goes through.
 */
export async function seedGrowthCountsUnderCeilings(
  deps: GrowthSeedDeps,
  plan: GrowthSeedPlan,
  ceilings: GrowthCeilings
): Promise<GrowthSeedOutcome> {
  const campaignsMinted = await runSettlement(deps.db, (tx) => mintCampaigns(tx, plan.campaigns));
  const tally: Tally = {
    beaconsCounted: 0,
    startsCounted: 0,
    hoursRolled: 0,
    addressBudgetsFilled: 0,
    overflowLatched: [],
    landingsClamped: [],
  };
  for (const hour of plan.hours) {
    await countBeacons(deps, hour, ceilings, tally);
    await countStarts(deps, hour, ceilings, tally);
    const bucket = growthHourBucket(hour.at);
    const outcome = valueOf(
      await rollupGrowthHour({ db: deps.db, redis: deps.redis, hour: bucket, now: new Date() }),
      `rolling hour ${bucket}`
    );
    // The keys were written moments ago by the loop above, so anything but a
    // rolled hour means the plan asked for an hour it counted nothing in —
    // which would leave the dashboard a hole no later run fills.
    if (outcome.kind !== 'rolled') {
      throw new Error(`growth seed: hour ${bucket} counted nothing, so there was nothing to roll`);
    }
    // A stored landing count above what this run just counted cannot have come
    // from the plan, so it says the counting store lost members the rows
    // outlived. It rides out on the outcome for the command that ran the seed
    // to print, the way the ceiling flags beside it do: a backend module has no
    // console of its own, and the retained channel belongs to the scheduled run
    // rather than to a local fixture.
    tally.landingsClamped.push(
      ...outcome.clamped.map((row) => `${row.grain} ${row.bucket} ${row.path}`)
    );
    tally.hoursRolled += 1;
  }
  return { campaignsMinted, ...tally };
}

/**
 * Seeds the growth tables through the counting path, under the ceilings the
 * running system counts under. The one door a seed script calls.
 */
export function seedGrowthCounts(
  deps: GrowthSeedDeps,
  plan: GrowthSeedPlan
): Promise<GrowthSeedOutcome> {
  return seedGrowthCountsUnderCeilings(deps, plan, GROWTH_CEILINGS);
}
