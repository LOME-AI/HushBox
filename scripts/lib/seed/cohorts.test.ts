import { describe, expect, it } from 'vitest';
import { ACQUISITION_PLATFORMS, GROWTH_CHANNELS, GROWTH_DIRECT_CAMPAIGN } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { GROWTH_SEED_CAMPAIGNS } from './growth.js';
import { GROWTH_COHORT_DAYS, buildGrowthCohortPlan, growthCohortFigures } from './cohorts.js';
import type { GrowthCohortAccount } from './cohorts.js';

/** Midnight of the run day in UTC — the newest instant a plan may name. */
const RUN_DAY_MIDNIGHT = TEST_DAY_START;

/**
 * A fixed instant to plan from, somewhere inside that day. Offset from the
 * day's own opening rather than spelled as a moment, so the fixture carries no
 * reading finer than the day it belongs to.
 */
const RUN_DAY = new Date(RUN_DAY_MIDNIGHT + DAY_MS / 3);

/** The week the ladder's return rung measures against: seven days past the account's own instant. */
const RETURN_WINDOW_MS = 7 * DAY_MS;

/**
 * An account described with its turns blanked: the turns grow as days pass, and
 * everything else about an account is fixed the moment it is planned.
 */
function besidesItsTurns(account: GrowthCohortAccount): GrowthCohortAccount {
  return { ...account, usage: [] };
}

/**
 * Every account a run day and the run day a week later both plan, paired with
 * the two descriptions of it — the comparison that says a seeded row keeps
 * matching the plan that describes it.
 */
function sharedAcrossARunWeek(): [GrowthCohortAccount, GrowthCohortAccount][] {
  const laterByEmail = new Map(
    buildGrowthCohortPlan(new Date(RUN_DAY.getTime() + 7 * DAY_MS)).map((account) => [
      account.email,
      account,
    ])
  );
  const pairs = buildGrowthCohortPlan(RUN_DAY).flatMap<[GrowthCohortAccount, GrowthCohortAccount]>(
    (account) => {
      const later = laterByEmail.get(account.email);
      return later === undefined ? [] : [[account, later]];
    }
  );
  expect(pairs.length).toBeGreaterThan(0);
  return pairs;
}

/** Whether a turn lands late enough for the ladder to read its account as having come back. */
function returnsIn(account: { readonly createdAt: Date }, turn: { readonly at: Date }): boolean {
  return turn.at.getTime() - account.createdAt.getTime() >= RETURN_WINDOW_MS;
}

describe('buildGrowthCohortPlan', () => {
  it('creates every account inside the window the cohort reads cover', () => {
    const oldest = RUN_DAY_MIDNIGHT - (GROWTH_COHORT_DAYS - 1) * DAY_MS;
    for (const account of buildGrowthCohortPlan(RUN_DAY)) {
      expect(account.createdAt.getTime()).toBeGreaterThanOrEqual(oldest);
    }
  });

  it('names no instant later than the run day', () => {
    for (const account of buildGrowthCohortPlan(RUN_DAY)) {
      expect(account.createdAt.getTime()).toBeLessThanOrEqual(RUN_DAY_MIDNIGHT);
    }
  });

  it('spreads the accounts over more than one creation week', () => {
    const weeks = new Set(
      buildGrowthCohortPlan(RUN_DAY).map((account) => account.createdAt.toISOString().slice(0, 7))
    );
    expect(weeks.size).toBeGreaterThan(1);
  });

  it('gives every campaign the growth seed mints accounts of its own', () => {
    const tags = new Set(buildGrowthCohortPlan(RUN_DAY).map((account) => account.campaign));
    for (const campaign of GROWTH_SEED_CAMPAIGNS) {
      expect(tags).toContain(campaign.tag);
    }
    expect(tags).toContain(GROWTH_DIRECT_CAMPAIGN);
  });

  it('answers the channel question with more than one channel', () => {
    const channels = new Set(
      buildGrowthCohortPlan(RUN_DAY)
        .map((account) => account.selfReportedChannel)
        .filter((channel) => channel !== null)
    );
    expect(channels.size).toBeGreaterThan(1);
    for (const channel of channels) expect(GROWTH_CHANNELS).toContain(channel);
  });

  it('leaves some accounts unanswered, so the answered rate is not a constant', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    expect(plan.some((account) => account.selfReportedChannel === null)).toBe(true);
    expect(plan.some((account) => account.selfReportedChannel !== null)).toBe(true);
  });

  it('records every platform the acquisition row admits', () => {
    const platforms = new Set(buildGrowthCohortPlan(RUN_DAY).map((account) => account.platform));
    expect(platforms).toEqual(new Set(ACQUISITION_PLATFORMS));
  });

  it('leaves some accounts unverified, so the verified rung is below the created one', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    expect(plan.some((account) => account.emailVerified)).toBe(true);
    expect(plan.some((account) => !account.emailVerified)).toBe(true);
  });

  it('verifies accounts under every campaign, so no campaign reads as a dead rung', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    const campaigns = new Set(plan.map((account) => account.campaign));
    for (const campaign of campaigns) {
      const under = plan.filter((account) => account.campaign === campaign);
      expect(under.some((account) => account.emailVerified)).toBe(true);
    }
  });

  it('pays for a minority of accounts, never before the account existed', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    const paid = plan.filter((account) => account.payment !== null);
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.length).toBeLessThan(plan.length);
    for (const account of paid) {
      expect(account.payment?.at.getTime()).toBeGreaterThanOrEqual(account.createdAt.getTime());
      expect(account.payment?.at.getTime()).toBeLessThanOrEqual(RUN_DAY_MIDNIGHT);
    }
  });

  it('sends a first turn for some accounts and none for others', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    expect(plan.some((account) => account.usage.length > 0)).toBe(true);
    expect(plan.some((account) => account.usage.length === 0)).toBe(true);
  });

  it('dates every turn after the account that sent it, never past the run day', () => {
    for (const account of buildGrowthCohortPlan(RUN_DAY)) {
      for (const turn of account.usage) {
        expect(turn.at.getTime()).toBeGreaterThan(account.createdAt.getTime());
        expect(turn.at.getTime()).toBeLessThanOrEqual(RUN_DAY_MIDNIGHT);
      }
    }
  });

  it('sends a turn under every campaign, so no campaign reads as never activated', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    for (const campaign of new Set(plan.map((account) => account.campaign))) {
      const under = plan.filter((account) => account.campaign === campaign);
      expect(under.some((account) => account.usage.length > 0)).toBe(true);
    }
  });

  it('brings some accounts back a week after they signed up', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    const returned = plan.filter((account) =>
      account.usage.some((turn) => returnsIn(account, turn))
    );
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.length).toBeLessThan(plan.filter((account) => account.usage.length > 0).length);
  });

  it('brings an account back under every campaign, so no campaign reads as a dead return rung', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    for (const campaign of new Set(plan.map((account) => account.campaign))) {
      const under = plan.filter((account) => account.campaign === campaign);
      expect(under.some((account) => account.usage.some((turn) => returnsIn(account, turn)))).toBe(
        true
      );
    }
  });

  it('brings no account back whose first week has not passed yet', () => {
    for (const account of buildGrowthCohortPlan(RUN_DAY)) {
      if (RUN_DAY_MIDNIGHT - account.createdAt.getTime() >= RETURN_WINDOW_MS) continue;
      expect(account.usage.some((turn) => returnsIn(account, turn))).toBe(false);
    }
  });

  it('gives every account its own identity', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    expect(new Set(plan.map((account) => account.email)).size).toBe(plan.length);
    expect(new Set(plan.map((account) => account.username)).size).toBe(plan.length);
  });

  it('mints usernames the account column and its rule both admit', () => {
    for (const account of buildGrowthCohortPlan(RUN_DAY)) {
      expect(account.username).toMatch(/^[a-z][a-z0-9_]{2,19}$/);
    }
  });

  it('plans the same accounts, at the same instants, from two moments of one UTC day', () => {
    const early = buildGrowthCohortPlan(new Date(RUN_DAY_MIDNIGHT + 1));
    const late = buildGrowthCohortPlan(new Date(RUN_DAY_MIDNIGHT + DAY_MS - 1));
    expect(late).toEqual(early);
  });

  it('describes an account the same way on a later run day, so a seeded row never stops matching its plan', () => {
    for (const [account, later] of sharedAcrossARunWeek()) {
      expect(besidesItsTurns(later)).toEqual(besidesItsTurns(account));
    }
  });

  it('only ever adds turns to an account already planned, never moves or drops one', () => {
    for (const [account, later] of sharedAcrossARunWeek()) {
      expect(later.usage.slice(0, account.usage.length)).toEqual(account.usage);
      expect(later.usage.length).toBeGreaterThanOrEqual(account.usage.length);
    }
  });

  it('slides the window by one account a step rather than naming a second population', () => {
    const today = new Set(buildGrowthCohortPlan(RUN_DAY).map((account) => account.email));
    const later = buildGrowthCohortPlan(new Date(RUN_DAY.getTime() + 2 * DAY_MS));
    const fresh = later.filter((account) => !today.has(account.email));
    expect(fresh).toHaveLength(1);
  });
});

describe('growthCohortFigures', () => {
  it('reports what the plan will produce, read off the plan itself', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    const figures = growthCohortFigures(plan);

    expect(figures.accounts).toBe(plan.length);
    expect(figures.verified).toBe(plan.filter((account) => account.emailVerified).length);
    expect(figures.answered).toBe(
      plan.filter((account) => account.selfReportedChannel !== null).length
    );
    expect(figures.paid).toBe(plan.filter((account) => account.payment !== null).length);
    expect(figures.campaignTags).toEqual(
      [...new Set(plan.map((account) => account.campaign))].toSorted((left, right) =>
        left.localeCompare(right)
      )
    );
  });

  it('counts the accounts that sent a turn and the ones that came back', () => {
    const plan = buildGrowthCohortPlan(RUN_DAY);
    const figures = growthCohortFigures(plan);

    expect(figures.activated).toBe(plan.filter((account) => account.usage.length > 0).length);
    expect(figures.returned).toBe(
      plan.filter((account) => account.usage.some((turn) => returnsIn(account, turn))).length
    );
  });
});
