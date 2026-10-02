import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  campaigns,
  createDb,
  growthCampaignPaths,
  growthDailyPathReach,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthHourlyProductEntry,
  growthVisitors,
  marketingDailyView,
  userAcquisition,
  users,
} from '@hushbox/db';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { growthDayBucket } from '../../../lib/redis/index.js';
import { createGrowthReads, pathReachWindow } from './reads.js';
import type { Database } from '@hushbox/db';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for growth read integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const reads = createGrowthReads();

/** UTC Monday of the week holding `instantMs`, the boundary `date_trunc('week', …, 'UTC')` lands on. */
function weekStart(instantMs: number): Date {
  const day = new Date(instantMs);
  const weekdayFromMonday = (day.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - weekdayFromMonday * DAY_MS
  );
}

const WEEK = weekStart(TEST_DAY_START);
const NEXT_WEEK = new Date(WEEK.getTime() + 7 * DAY_MS);
const DAY = new Date(WEEK.getTime() + DAY_MS);
const HOUR = new Date(DAY.getTime() + 8 * HOUR_MS);
/** A bucket outside the read window, so the range filter has something to exclude. */
const EARLIER_DAY = new Date(WEEK.getTime() - 3 * DAY_MS);

const CAMPAIGN = `reads-${crypto.randomUUID().slice(0, 8)}`;
const OTHER_CAMPAIGN = `other-${crypto.randomUUID().slice(0, 8)}`;
/** An archived campaign, so the campaign list has a non-active status to report. */
const RETIRED_CAMPAIGN = `retired-${crypto.randomUUID().slice(0, 8)}`;
/** A campaign whose only rows hit their ceiling, so a week of it is a floor. */
const FLOOR_CAMPAIGN = `floor-${crypto.randomUUID().slice(0, 8)}`;
/** An earlier hour inside the same day, so the event window has something to exclude. */
const EARLIER_HOUR = new Date(HOUR.getTime() - 3 * HOUR_MS);
const userIds: string[] = [];

/**
 * The fixture for the newest-bucket read. Its rows sit more than ten years
 * past the reference day, later than anything the rest of this suite or the
 * local seed writes, so a read that answers with the newest bucket of a whole
 * set can be asserted exactly against a database other fixtures share.
 *
 * Each set gets its own day, so an answer that read one set's bucket for
 * another's is visible here rather than hidden behind four equal values.
 */
const NEWEST_WEEK = weekStart(TEST_DAY_START + 4000 * DAY_MS);
/** The hour the newest named event happened, the day after the funnel's week opens. */
const NEWEST_EVENT_HOUR = new Date(NEWEST_WEEK.getTime() + DAY_MS + 5 * HOUR_MS);
/** The day-grain visitor bucket, later still, so the marketing answer is its own. */
const NEWEST_VISITOR_DAY = new Date(NEWEST_WEEK.getTime() + 2 * DAY_MS);
/**
 * An hour-grain visitor bucket later than every day-grain row. No fixture
 * holds it: the marketing answer the rest of this suite states exactly is the
 * day-grain bucket, so the one case that needs the hour to be the later of the
 * two writes it and takes it away again.
 */
const LATER_VISITOR_HOUR = new Date(NEWEST_VISITOR_DAY.getTime() + 5 * HOUR_MS);
/** The week the newest account was created in, one before the funnel's, so the sources answer is its own too. */
const NEWEST_SOURCES_WEEK = new Date(NEWEST_WEEK.getTime() - 7 * DAY_MS);
const NEWEST_ACCOUNT_AT = new Date(NEWEST_SOURCES_WEEK.getTime() + 9 * HOUR_MS);
const NEWEST_CAMPAIGN = `newest-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The reach fixture's own paths. The table carries no campaign, so the paths
 * are what scopes these rows to this suite; every one of them satisfies the
 * shared path pattern the column checks enforce.
 */
const REACH_SUFFIX = CAMPAIGN.slice(-8);
const LANDED_ONE = `/reach-one-${REACH_SUFFIX}`;
const LANDED_TWO = `/reach-two-${REACH_SUFFIX}`;
const REACHED_ONE = `/reached-one-${REACH_SUFFIX}`;
const REACHED_TWO = `/reached-two-${REACH_SUFFIX}`;
const REACH_LANDING_PATHS = [LANDED_ONE, LANDED_TWO];

const blob = new Uint8Array([4, 5, 6]);

beforeAll(async () => {
  await db.insert(campaigns).values([
    { tag: CAMPAIGN, label: CAMPAIGN, status: 'active' },
    { tag: OTHER_CAMPAIGN, label: OTHER_CAMPAIGN, status: 'active' },
    { tag: RETIRED_CAMPAIGN, label: 'a campaign nobody is running', status: 'archived' },
    { tag: FLOOR_CAMPAIGN, label: FLOOR_CAMPAIGN, status: 'active' },
  ]);
  await db.insert(growthCampaignPaths).values([
    { grain: 'day', bucket: DAY, campaign: CAMPAIGN, path: '/', visitors: 12 },
    { grain: 'day', bucket: EARLIER_DAY, campaign: CAMPAIGN, path: '/', visitors: 99 },
    { grain: 'day', bucket: DAY, campaign: OTHER_CAMPAIGN, path: '/', visitors: 5 },
  ]);
  await db.insert(growthVisitors).values({ grain: 'hour', bucket: HOUR, visitors: 20 });
  await db.insert(growthHourlyProductEntry).values({ hour: HOUR, visitors: 6 });
  await db.insert(growthHourlyEvents).values([
    { hour: HOUR, campaign: CAMPAIGN, eventName: 'cta_hero', path: '/', visitors: 4 },
    { hour: HOUR, campaign: CAMPAIGN, eventName: 'cta_hero', path: '/pricing', visitors: 3 },
    { hour: EARLIER_HOUR, campaign: CAMPAIGN, eventName: 'cta_hero', path: '/', visitors: 9 },
    {
      hour: HOUR,
      campaign: OTHER_CAMPAIGN,
      eventName: 'link:/pricing',
      path: '/',
      visitors: 2,
      overflow: true,
    },
    // A click into the product whose hour hit its ceiling, so the week built
    // from it is a floor. Its own campaign, so the fixture the flag needs does
    // not move a count another test states exactly.
    {
      hour: HOUR,
      campaign: FLOOR_CAMPAIGN,
      eventName: 'link:/signup',
      path: '/',
      visitors: 7,
      overflow: true,
    },
  ]);
  await db.insert(growthDailyPathReach).values([
    {
      day: growthDayBucket(DAY),
      landingPath: LANDED_ONE,
      reachedPath: REACHED_ONE,
      visitors: 3,
      overflow: true,
    },
    {
      day: growthDayBucket(new Date(DAY.getTime() + DAY_MS)),
      landingPath: LANDED_ONE,
      reachedPath: REACHED_ONE,
      visitors: 4,
    },
    { day: growthDayBucket(DAY), landingPath: LANDED_TWO, reachedPath: REACHED_TWO, visitors: 5 },
    {
      day: growthDayBucket(EARLIER_DAY),
      landingPath: LANDED_ONE,
      reachedPath: REACHED_ONE,
      visitors: 99,
    },
  ]);
  await db.insert(growthHourlyFunnel).values({
    hour: HOUR,
    campaign: CAMPAIGN,
    step: 'started',
    registrations: 6,
  });

  const [row] = await db
    .insert(users)
    .values({
      email: `reads-${CAMPAIGN}@test.hushbox.ai`,
      username: `reads_${CAMPAIGN.slice(-8)}`,
      emailVerified: true,
      createdAt: new Date(DAY.getTime() + 9 * HOUR_MS),
      opaqueRegistration: blob,
      opaqueServerMaterial: blob,
      opaqueKekFingerprint: blob,
      publicKey: blob,
      passwordWrappedPrivateKey: blob,
      recoveryWrappedPrivateKey: blob,
      recoveryPublicKey: blob,
    })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  userIds.push(row.id);
  await db.insert(userAcquisition).values({
    userId: row.id,
    campaign: CAMPAIGN,
    platform: 'web',
    selfReportedChannel: 'search',
    selfReportedContext: 'post_signup',
    selfReportedAt: new Date(DAY.getTime() + 10 * HOUR_MS),
  });

  await db
    .insert(campaigns)
    .values({ tag: NEWEST_CAMPAIGN, label: NEWEST_CAMPAIGN, status: 'active' });
  await db.insert(growthCampaignPaths).values({
    grain: 'day',
    bucket: NEWEST_WEEK,
    campaign: NEWEST_CAMPAIGN,
    path: '/',
    visitors: 2,
  });
  await db.insert(growthHourlyEvents).values({
    hour: NEWEST_EVENT_HOUR,
    campaign: NEWEST_CAMPAIGN,
    eventName: 'cta_hero',
    path: '/',
    visitors: 1,
  });
  await db.insert(growthVisitors).values({ grain: 'day', bucket: NEWEST_VISITOR_DAY, visitors: 3 });

  const [newest] = await db
    .insert(users)
    .values({
      email: `newest-${NEWEST_CAMPAIGN}@test.hushbox.ai`,
      username: `newest_${NEWEST_CAMPAIGN.slice(-8)}`,
      emailVerified: true,
      createdAt: NEWEST_ACCOUNT_AT,
      opaqueRegistration: blob,
      opaqueServerMaterial: blob,
      opaqueKekFingerprint: blob,
      publicKey: blob,
      passwordWrappedPrivateKey: blob,
      recoveryWrappedPrivateKey: blob,
      recoveryPublicKey: blob,
    })
    .returning({ id: users.id });
  if (!newest) throw new Error('newest-bucket user insert returned no row');
  userIds.push(newest.id);
  await db
    .insert(userAcquisition)
    .values({ userId: newest.id, campaign: NEWEST_CAMPAIGN, platform: 'web' });
}, 60_000);

afterAll(async () => {
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  const tags = [CAMPAIGN, OTHER_CAMPAIGN, RETIRED_CAMPAIGN, FLOOR_CAMPAIGN, NEWEST_CAMPAIGN];
  await db.delete(growthCampaignPaths).where(inArray(growthCampaignPaths.campaign, tags));
  await db.delete(growthHourlyEvents).where(inArray(growthHourlyEvents.campaign, tags));
  await db.delete(growthHourlyFunnel).where(inArray(growthHourlyFunnel.campaign, tags));
  await db
    .delete(growthVisitors)
    .where(inArray(growthVisitors.bucket, [HOUR, NEWEST_VISITOR_DAY, LATER_VISITOR_HOUR]));
  await db.delete(growthHourlyProductEntry).where(inArray(growthHourlyProductEntry.hour, [HOUR]));
  await db
    .delete(growthDailyPathReach)
    .where(inArray(growthDailyPathReach.landingPath, REACH_LANDING_PATHS));
  await db.delete(campaigns).where(inArray(campaigns.tag, tags));
});

describe('readMarketing', () => {
  it('answers the hourly families inside the window', async () => {
    const result = await reads.readMarketing(db, { grain: 'hour', from: WEEK, to: NEXT_WEEK });
    const rows = result._unsafeUnwrap().filter((row) => row.bucket.getTime() === HOUR.getTime());
    expect(rows).toContainEqual(
      expect.objectContaining({ family: 'total', visitors: 20, path: null })
    );
  });

  // The unscoped entry figure rides the read the visitor marginal rides, as
  // its own family: no count of entrants carries a campaign, so nothing in the
  // campaign-dimensioned families could be added up into it.
  it('answers the campaign-free product-entry count among the hourly families', async () => {
    const result = await reads.readMarketing(db, { grain: 'hour', from: WEEK, to: NEXT_WEEK });
    const rows = result._unsafeUnwrap().filter((row) => row.bucket.getTime() === HOUR.getTime());
    expect(rows).toContainEqual(
      expect.objectContaining({ family: 'product-entry', visitors: 6, campaign: null })
    );
  });

  it('answers the daily families for the day grain, and none of the hourly ones', async () => {
    const result = await reads.readMarketing(db, { grain: 'day', from: WEEK, to: NEXT_WEEK });
    const rows = result._unsafeUnwrap();
    expect(rows.some((row) => row.campaign === CAMPAIGN && row.visitors === 12)).toBe(true);
    expect(rows.some((row) => row.bucket.getTime() === HOUR.getTime())).toBe(false);
  });

  it('excludes a bucket before the window', async () => {
    const result = await reads.readMarketing(db, { grain: 'day', from: WEEK, to: NEXT_WEEK });
    const rows = result._unsafeUnwrap();
    expect(rows.some((row) => row.visitors === 99)).toBe(false);
  });
});

describe('readFunnelWeeks', () => {
  it('answers the ladder for one campaign', async () => {
    const result = await reads.readFunnelWeeks(db, {
      from: WEEK,
      to: NEXT_WEEK,
      campaign: CAMPAIGN,
    });
    expect(result._unsafeUnwrap()).toEqual([
      {
        week: WEEK,
        campaign: CAMPAIGN,
        visitorsDailySummed: 12,
        visitorsOverflow: false,
        productEntryClicksHourlySummed: 0,
        productEntryClicksOverflow: false,
        started: 6,
        startedOverflow: false,
        finished: 1,
        verified: 1,
        activated: 0,
        returnedWeek1: 0,
        firstPaid: 0,
        revenueNanoUsd: 0n,
      },
    ]);
  });

  it('carries the ceiling flag of the rows a week was built from', async () => {
    const result = await reads.readFunnelWeeks(db, {
      from: WEEK,
      to: NEXT_WEEK,
      campaign: FLOOR_CAMPAIGN,
    });
    const [row] = result._unsafeUnwrap();
    expect(row?.productEntryClicksHourlySummed).toBe(7);
    expect(row?.productEntryClicksOverflow).toBe(true);
  });

  it('answers every campaign in the window when none is named', async () => {
    const result = await reads.readFunnelWeeks(db, { from: WEEK, to: NEXT_WEEK });
    const tags = result._unsafeUnwrap().map((row) => row.campaign);
    expect(tags).toContain(CAMPAIGN);
    expect(tags).toContain(OTHER_CAMPAIGN);
  });

  it('excludes a week outside the window', async () => {
    const result = await reads.readFunnelWeeks(db, {
      from: NEXT_WEEK,
      to: new Date(NEXT_WEEK.getTime() + 7 * DAY_MS),
    });
    expect(result._unsafeUnwrap().map((row) => row.campaign)).not.toContain(CAMPAIGN);
  });
});

describe('readAcquisitionSources', () => {
  it('answers the self-reported channel as the primary source', async () => {
    const result = await reads.readAcquisitionSources(db, { from: WEEK, to: NEXT_WEEK });
    const rows = result._unsafeUnwrap().filter((row) => row.campaign === CAMPAIGN);
    expect(rows).toEqual([
      {
        userCreatedWeek: WEEK,
        campaign: CAMPAIGN,
        selfReportedChannel: 'search',
        selfReportedContext: 'post_signup',
        primarySource: 'search',
      },
    ]);
  });
});

describe('readCampaigns', () => {
  it('answers every campaign with its status, archived ones included', async () => {
    const result = await reads.readCampaigns(db);
    const rows = result._unsafeUnwrap();
    expect(rows).toContainEqual({
      tag: CAMPAIGN,
      label: CAMPAIGN,
      status: 'active',
      createdAt: expect.any(Date),
    });
    expect(rows).toContainEqual({
      tag: RETIRED_CAMPAIGN,
      label: 'a campaign nobody is running',
      status: 'archived',
      createdAt: expect.any(Date),
    });
  });

  it('answers the two seeded tags, which every count folds to', async () => {
    const result = await reads.readCampaigns(db);
    const tags = result._unsafeUnwrap().map((row) => row.tag);
    expect(tags).toContain('direct');
    expect(tags).toContain('unknown');
  });

  it('carries no row identifier', async () => {
    const result = await reads.readCampaigns(db);
    const row = result._unsafeUnwrap().find((candidate) => candidate.tag === CAMPAIGN);
    expect(Object.keys(row ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'createdAt',
      'label',
      'status',
      'tag',
    ]);
  });
});

describe('readHourlyEvents', () => {
  it('answers one row per event and page in the window', async () => {
    const result = await reads.readHourlyEvents(db, {
      from: HOUR,
      to: new Date(HOUR.getTime() + HOUR_MS),
      campaign: CAMPAIGN,
    });
    expect(result._unsafeUnwrap()).toEqual([
      {
        hour: HOUR,
        campaign: CAMPAIGN,
        eventName: 'cta_hero',
        path: '/',
        visitors: 4,
        overflow: false,
      },
      {
        hour: HOUR,
        campaign: CAMPAIGN,
        eventName: 'cta_hero',
        path: '/pricing',
        visitors: 3,
        overflow: false,
      },
    ]);
  });

  it('excludes an hour before the window', async () => {
    const result = await reads.readHourlyEvents(db, {
      from: HOUR,
      to: new Date(HOUR.getTime() + HOUR_MS),
      campaign: CAMPAIGN,
    });
    expect(result._unsafeUnwrap().some((row) => row.visitors === 9)).toBe(false);
  });

  it('answers every campaign in the window when none is named', async () => {
    const result = await reads.readHourlyEvents(db, { from: EARLIER_HOUR, to: NEXT_WEEK });
    const rows = result
      ._unsafeUnwrap()
      .filter((row) => row.campaign === CAMPAIGN || row.campaign === OTHER_CAMPAIGN);
    expect(rows.map((row) => row.campaign)).toContain(OTHER_CAMPAIGN);
    expect(rows.map((row) => row.campaign)).toContain(CAMPAIGN);
  });

  it('narrows to one page when a path is named', async () => {
    const result = await reads.readHourlyEvents(db, {
      from: EARLIER_HOUR,
      to: NEXT_WEEK,
      campaign: CAMPAIGN,
      path: '/pricing',
    });
    expect(result._unsafeUnwrap().map((row) => row.visitors)).toEqual([3]);
  });

  it('reports the overflow flag the rollup wrote', async () => {
    const result = await reads.readHourlyEvents(db, {
      from: HOUR,
      to: new Date(HOUR.getTime() + HOUR_MS),
      campaign: OTHER_CAMPAIGN,
    });
    expect(result._unsafeUnwrap()).toEqual([
      {
        hour: HOUR,
        campaign: OTHER_CAMPAIGN,
        eventName: 'link:/pricing',
        path: '/',
        visitors: 2,
        overflow: true,
      },
    ]);
  });
});

/**
 * A client pointed at a port nothing listens on, so a read fails inside the
 * driver rather than inside a stand-in for it.
 */
const unreachable = createDb('postgresql://nobody@127.0.0.1:1/none', {
  neonDev: LOCAL_NEON_DEV_CONFIG,
});

describe('readPathReach', () => {
  const reachRowsFor = async (
    from: Date,
    to: Date
  ): Promise<
    readonly {
      landingPath: string;
      reachedPath: string;
      visitorsDailySummed: number;
      overflow: boolean;
    }[]
  > => {
    const result = await reads.readPathReach(db, { from, to });
    return result._unsafeUnwrap().filter((row) => REACH_LANDING_PATHS.includes(row.landingPath));
  };

  it('sums the days a pair was counted on into one row', async () => {
    expect(await reachRowsFor(WEEK, NEXT_WEEK)).toEqual([
      { landingPath: LANDED_ONE, reachedPath: REACHED_ONE, visitorsDailySummed: 7, overflow: true },
      {
        landingPath: LANDED_TWO,
        reachedPath: REACHED_TWO,
        visitorsDailySummed: 5,
        overflow: false,
      },
    ]);
  });

  it('counts only the days inside the window', async () => {
    const widened = await reachRowsFor(EARLIER_DAY, NEXT_WEEK);

    expect(widened.find((row) => row.landingPath === LANDED_ONE)?.visitorsDailySummed).toBe(106);
  });

  // A day belongs to a window when the day's own start instant does, which is
  // the rule every read in this module shares. A window whose ends fall
  // part-way through a day is where that rule is observable: floor both ends
  // instead and the two edges move in opposite directions, each by a whole day.
  it('contains the day a window ends part-way through', async () => {
    const endsMidMorning = new Date(DAY.getTime() + 10 * HOUR_MS);

    expect(await reachRowsFor(WEEK, endsMidMorning)).toEqual([
      { landingPath: LANDED_ONE, reachedPath: REACHED_ONE, visitorsDailySummed: 3, overflow: true },
      {
        landingPath: LANDED_TWO,
        reachedPath: REACHED_TWO,
        visitorsDailySummed: 5,
        overflow: false,
      },
    ]);
  });

  // The day this window omits is the pair's capped one, so the flag reduces
  // over exactly the days the window holds: a summed figure whose only floor
  // day fell outside reports the exact figure it has.
  it('omits the day a window starts part-way through', async () => {
    const startsMidMorning = new Date(DAY.getTime() + 8 * HOUR_MS);

    expect(await reachRowsFor(startsMidMorning, NEXT_WEEK)).toEqual([
      {
        landingPath: LANDED_ONE,
        reachedPath: REACHED_ONE,
        visitorsDailySummed: 4,
        overflow: false,
      },
    ]);
  });

  /**
   * The plan the database chooses for the read's own day range, with
   * sequential scans penalised. The penalty is not a prohibition — the planner
   * still falls back to a scan when a predicate cannot address an index — so
   * what survives it is a statement about whether the range is addressable at
   * all rather than about how big the table happens to be under test.
   *
   * The projection is this test's; the filter is
   * {@link pathReachWindow}, the read's own.
   */
  const explainPathReachWindow = async (from: Date, to: Date): Promise<string> => {
    const query = db
      .select({ visitors: growthDailyPathReach.visitors })
      .from(growthDailyPathReach)
      .where(pathReachWindow({ from, to }));
    const explained = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN ${query.getSQL()}`);
    });
    const rows = explained.rows as { 'QUERY PLAN': string }[];
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  };

  // The table is retained forever and nothing prunes it, so a scan's cost
  // tracks lifetime rows rather than the window the caller asked for. The
  // read-window cap bounds what this read returns, never what it would scan.
  it('addresses the day range through the day-leading unique index', async () => {
    const plan = await explainPathReachWindow(WEEK, NEXT_WEEK);

    expect(plan).toContain('growth_daily_path_reach_day_landing_reached_unique');
  });

  it('never falls back to a sequential scan of the reach table', async () => {
    const plan = await explainPathReachWindow(WEEK, NEXT_WEEK);

    expect(plan).not.toContain('Seq Scan on growth_daily_path_reach');
  });

  // The pair is the row. Two landing pages each with their own reached page
  // give a cross product two members wider than the table, and a read that
  // completed the product would report a pair nothing was ever counted for.
  it('omits a pair the table holds no row for', async () => {
    const rows = await reachRowsFor(WEEK, NEXT_WEEK);

    expect(
      rows
        .map((row) => `${row.landingPath} ${row.reachedPath}`)
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual([`${LANDED_ONE} ${REACHED_ONE}`, `${LANDED_TWO} ${REACHED_TWO}`]);
  });
});

describe('a view query the database cannot answer', () => {
  // The counter-case is the first assertion: the same query, unwrapped,
  // rejects. So the second assertion is a claim about this adapter converting
  // a rejection into a value the route can classify, not about the driver
  // happening to resolve.
  it('resolves to an unavailable value where the bare query rejects', async () => {
    await expect(unreachable.select().from(marketingDailyView)).rejects.toThrow();

    const result = await reads.readMarketing(unreachable, {
      grain: 'day',
      from: WEEK,
      to: NEXT_WEEK,
    });
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('marketing');
    // The driver's own failure, carried whole: the taxonomy code names no
    // dependency, so the cause chain is the only place the failure's identity
    // survives to a capture.
    expect(error.cause).toBeInstanceOf(Error);
  });

  // All three reads answer the one taxonomy code, so the code cannot say which
  // view query failed. The message is the only field that does.
  it('names the funnel read in the error a failed funnel query returns', async () => {
    const result = await reads.readFunnelWeeks(unreachable, { from: WEEK, to: NEXT_WEEK });
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('funnel');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('names the acquisition-source read in the error a failed source query returns', async () => {
    const result = await reads.readAcquisitionSources(unreachable, { from: WEEK, to: NEXT_WEEK });
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('acquisition');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('names the campaign list in the error a failed campaign query returns', async () => {
    const result = await reads.readCampaigns(unreachable);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('campaign');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('names the path-reach read in the error a failed reach query returns', async () => {
    const result = await reads.readPathReach(unreachable, { from: WEEK, to: NEXT_WEEK });
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('reach');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('names the newest-bucket read in the error a failed currency query returns', async () => {
    const result = await reads.readNewestBuckets(unreachable);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('newest-bucket');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('names the event read in the error a failed event query returns', async () => {
    const result = await reads.readHourlyEvents(unreachable, { from: WEEK, to: NEXT_WEEK });
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('event');
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('readNewestBuckets', () => {
  it('answers the newest bucket each data set holds', async () => {
    const result = await reads.readNewestBuckets(db);

    expect(result._unsafeUnwrap()).toEqual({
      funnel: { grain: 'week', weekOpening: NEWEST_WEEK },
      sources: { grain: 'week', weekOpening: NEWEST_SOURCES_WEEK },
      marketing: { grain: 'day', runsThrough: NEWEST_VISITOR_DAY },
      events: { grain: 'day', runsThrough: NEWEST_EVENT_HOUR },
    });
  });

  it('answers the same buckets the narrowest window the dashboard can ask for excludes', async () => {
    // One whole day is the narrowest window the day controls produce, and the
    // week controls produce seven; every fixture above sits inside this one.
    const narrowest = { from: DAY, to: new Date(DAY.getTime() + DAY_MS) };

    const marketing = await reads.readMarketing(db, { ...narrowest, grain: 'day' });
    const funnel = await reads.readFunnelWeeks(db, narrowest);
    const sources = await reads.readAcquisitionSources(db, narrowest);
    const events = await reads.readHourlyEvents(db, narrowest);
    const newest = await reads.readNewestBuckets(db);

    expect(
      marketing._unsafeUnwrap().some((row) => row.bucket.getTime() >= NEWEST_WEEK.getTime())
    ).toBe(false);
    expect(funnel._unsafeUnwrap().some((row) => row.week.getTime() >= NEWEST_WEEK.getTime())).toBe(
      false
    );
    expect(
      sources
        ._unsafeUnwrap()
        .some((row) => row.userCreatedWeek.getTime() >= NEWEST_SOURCES_WEEK.getTime())
    ).toBe(false);
    expect(events._unsafeUnwrap().some((row) => row.hour.getTime() >= NEWEST_WEEK.getTime())).toBe(
      false
    );
    expect(newest._unsafeUnwrap()).toEqual({
      funnel: { grain: 'week', weekOpening: NEWEST_WEEK },
      sources: { grain: 'week', weekOpening: NEWEST_SOURCES_WEEK },
      marketing: { grain: 'day', runsThrough: NEWEST_VISITOR_DAY },
      events: { grain: 'day', runsThrough: NEWEST_EVENT_HOUR },
    });
  });

  /**
   * The one case in this file that does not read the real database. The
   * relations this read spans are never all empty in a database every suite
   * and the local seed share, so the answer for a set holding nothing has no
   * other way to be observed. Nothing about the driver is stood in for: an
   * empty relation resolves to an empty rows array, which is what this handle
   * returns.
   */
  it('answers no bucket at all where every relation holds no row', async () => {
    const chain: Record<string, unknown> = {};
    chain['from'] = () => chain;
    chain['orderBy'] = () => chain;
    chain['limit'] = () => Promise.resolve([]);
    const empty = { select: () => chain } as unknown as Database;

    const result = await reads.readNewestBuckets(empty);

    expect(result._unsafeUnwrap()).toEqual({
      funnel: null,
      sources: null,
      marketing: null,
      events: null,
    });
  });

  it('tags each set with what its own relation groups by', async () => {
    const result = await reads.readNewestBuckets(db);
    const newest = result._unsafeUnwrap();

    // The two signup sets group by week, so their newest value opens a week and
    // is earlier than the day their data runs through; the other two do not.
    expect([newest.funnel?.grain, newest.sources?.grain]).toEqual(['week', 'week']);
    expect([newest.marketing?.grain, newest.events?.grain]).toEqual(['day', 'day']);
  });

  it('reaches a day-grain marketing bucket no hour-grain row reaches', async () => {
    const hourly = await reads.readMarketing(db, {
      grain: 'hour',
      from: NEWEST_WEEK,
      to: new Date(NEWEST_WEEK.getTime() + 7 * DAY_MS),
    });
    const newest = await reads.readNewestBuckets(db);

    expect(hourly._unsafeUnwrap()).toEqual([]);
    expect(newest._unsafeUnwrap().marketing).toEqual({
      grain: 'day',
      runsThrough: NEWEST_VISITOR_DAY,
    });
  });

  // The direction a live system spends most of its time in: hours roll
  // continuously while days close once, so the hour bucket is ordinarily the
  // freshest thing the marketing set holds. The fixture's day-grain bucket
  // stays in place underneath, so the answer here is the later of two relations
  // that both hold a row, not the only one that does.
  it('reaches an hour-grain marketing bucket later than every day-grain row', async () => {
    await db
      .insert(growthVisitors)
      .values({ grain: 'hour', bucket: LATER_VISITOR_HOUR, visitors: 1 });

    try {
      const newest = await reads.readNewestBuckets(db);

      expect(newest._unsafeUnwrap().marketing).toEqual({
        grain: 'day',
        runsThrough: LATER_VISITOR_HOUR,
      });
    } finally {
      await db.delete(growthVisitors).where(eq(growthVisitors.bucket, LATER_VISITOR_HOUR));
    }
  });
});
