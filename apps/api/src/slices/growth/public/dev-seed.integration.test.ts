import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, gte, inArray, lt, or } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  campaigns,
  createDb,
  growthCampaignPaths,
  growthDailyPathReach,
  growthGeo,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthPaths,
  growthReferrers,
  growthVisitors,
} from '@hushbox/db';
import { GROWTH_CEILINGS } from '@hushbox/shared';
import { DAY_MS, HOUR_MS } from '@hushbox/shared/test-time';
import {
  GROWTH_INDEX_FAMILIES,
  GROWTH_REDIS_KEYS,
  growthDayBucket,
  growthHourBucket,
} from '../../../lib/redis/index.js';
import { GROWTH_SEEDED_DAY_TABLE, growthTestDays } from '../../../test-support/growth-test-days.js';
import { seedGrowthCounts, seedGrowthCountsUnderCeilings } from './dev-seed.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { GrowthSeedHour, GrowthSeedPlan, GrowthSeedVisitor } from './dev-seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the growth seed integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const redisKeys = new Set<string>();
const mintedTags: string[] = [];
const writtenDays: Date[] = [];

afterAll(async () => {
  if (redisKeys.size > 0) await redis.del(...redisKeys);
  for (const day of writtenDays) {
    const next = new Date(day.getTime() + DAY_MS);
    const within = (column: AnyPgColumn): ReturnType<typeof and> =>
      and(gte(column, day), lt(column, next));
    await db.delete(growthVisitors).where(within(growthVisitors.bucket));
    await db.delete(growthPaths).where(within(growthPaths.bucket));
    await db.delete(growthReferrers).where(within(growthReferrers.bucket));
    await db.delete(growthCampaignPaths).where(within(growthCampaignPaths.bucket));
    await db.delete(growthGeo).where(within(growthGeo.bucket));
    await db.delete(growthHourlyEvents).where(within(growthHourlyEvents.hour));
    await db.delete(growthHourlyFunnel).where(within(growthHourlyFunnel.hour));
    await db.delete(growthDailyPathReach).where(eq(growthDailyPathReach.day, growthDayBucket(day)));
  }
  if (mintedTags.length > 0) {
    await db.delete(campaigns).where(inArray(campaigns.tag, mintedTags));
  }
  await db.$client.end();
});

/** A short random label, so no two cases in this file can address one key, tag or page. */
function label(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Thirty-two lowercase hex characters — the shape the visitor sets' schema admits. */
function visitorOf(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** Sixty-four lowercase hex characters — the shape the address-identity sets' schema admits. */
function callerOf(): string {
  return `${visitorOf()}${visitorOf()}`;
}

/**
 * Where this file's cases sit, measured from the day the run is happening on.
 * The run day is what the placement has to be measured from: the ninety days
 * of growth rows the clone template carries are anchored to the day that
 * template's seed ran, and no fixed instant holds a chosen relationship to a
 * span that moves with the calendar.
 */
const DAYS = growthTestDays('seed-door', new Date());

/**
 * The index that places a case inside those ninety seeded days rather than in
 * the region no seed reaches. Exactly one case runs with another writer's rows
 * in its own buckets, deliberately, so that state is a standing check instead
 * of something a placement happens to produce on some runs and not others.
 *
 * The case holds itself to that: it reads the day before it writes and refuses
 * an empty one, because a template whose span ends before this day leaves the
 * case passing while it silently stands for the opposite state.
 */
const SEEDED_SPAN = -1;

/** A whole UTC day to itself per case: a bucket-global key and a bucket-global row are addressed by the bucket and nothing else. */
function dayApart(index: number): Date {
  return index === SEEDED_SPAN ? DAYS.seeded : DAYS.clean(index);
}

/**
 * How many growth rows the clone template's own seed left on the seeded day,
 * counted before this file writes to it — so every row counted is one this
 * file did not write.
 */
async function templateRowsOnSeededDay(): Promise<number> {
  const next = new Date(DAYS.seeded.getTime() + DAY_MS);
  const rows = await db
    .select({ bucket: GROWTH_SEEDED_DAY_TABLE.bucket })
    .from(GROWTH_SEEDED_DAY_TABLE)
    .where(
      and(
        gte(GROWTH_SEEDED_DAY_TABLE.bucket, DAYS.seeded),
        lt(GROWTH_SEEDED_DAY_TABLE.bucket, next)
      )
    );
  return rows.length;
}

/**
 * The day grain, named rather than written at the call below: what a test's key
 * takes from this file is its identity — here the case's own day and page — and
 * the grain is neither of those.
 */
const DAY_GRAIN = 'd';

/** The one place every case in this file counts from. */
const HERE = { country: 'US', region: 'CA', device: 'desktop' } as const;

/** A tag the mint door refuses for its shape: a label is shared by every clicker, so a per-person identifier is not one. */
const IDENTIFIER_SHAPED_TAG = '00000000-0000-4000-8000-000000000000';

/** The entry-click name the funnel's own step counts, unchanged from the site's derivation. */
const ENTRY_EVENT = 'link:/signup';

interface Case {
  readonly plan: GrowthSeedPlan;
  readonly campaign: string;
  readonly landingPath: string;
  readonly secondPath: string;
  readonly referrerHost: string;
  readonly hours: readonly { readonly hourAt: Date; readonly dayAt: Date; readonly day: string }[];
}

/**
 * A plan of `days` consecutive days, each one representative hour holding two
 * visitors — one of whom reaches a second page from a referrer and clicks the
 * product-entry link — and one registration start.
 */
function planOf(firstDayIndex: number, days: number): Case {
  const suffix = label();
  const campaign = `seedt-${suffix}`;
  mintedTags.push(campaign);
  const landingPath = `/land-${suffix}`;
  const secondPath = `/next-${suffix}`;
  const referrerHost = `news-${suffix}.example.com`;

  const hours = Array.from({ length: days }, (_, index) => {
    const dayAt = dayApart(firstDayIndex + index);
    writtenDays.push(dayAt);
    return { hourAt: new Date(dayAt.getTime() + 9 * HOUR_MS), dayAt, day: growthDayBucket(dayAt) };
  });

  const planHours: GrowthSeedHour[] = hours.map(({ hourAt }) => {
    const firstVisitor = { visitor: visitorOf(), addressId: callerOf() };
    const secondVisitor = { visitor: visitorOf(), addressId: callerOf() };
    return {
      at: hourAt,
      visitors: [
        {
          ...firstVisitor,
          ...HERE,
          campaign,
          views: [{ path: landingPath, referrerHost }, { path: secondPath }],
          events: [{ path: landingPath, eventName: ENTRY_EVENT }],
        },
        {
          ...secondVisitor,
          ...HERE,
          campaign,
          views: [{ path: landingPath }],
          events: [],
        },
      ],
      starts: [{ campaign, addressId: callerOf() }],
    };
  });

  const plan: GrowthSeedPlan = {
    campaigns: [{ tag: campaign, label: `Seed ${suffix}` }],
    hours: planHours,
  };
  trackPlanKeys(plan);
  return { plan, campaign, landingPath, secondPath, referrerHost, hours };
}

/** The address-keyed keys one identity opens in a day. */
function trackAddressKeys(dayBucket: string, addressId: string): void {
  redisKeys.add(GROWTH_REDIS_KEYS.mint.buildKey(dayBucket, addressId));
  redisKeys.add(GROWTH_REDIS_KEYS.mintCapped.buildKey(dayBucket, addressId));
}

/** The bucket-global keys of one grain, and the per-page keys one visitor's views open there. */
function trackGrainKeys(grain: 'h' | 'd', bucket: string, hour: GrowthSeedHour): void {
  redisKeys.add(GROWTH_REDIS_KEYS.visitors.buildKey(grain, bucket));
  redisKeys.add(GROWTH_REDIS_KEYS.overflow.buildKey(grain, bucket));
  redisKeys.add(GROWTH_REDIS_KEYS.geo.buildKey(grain, bucket, HERE));
  for (const family of GROWTH_INDEX_FAMILIES) {
    redisKeys.add(GROWTH_REDIS_KEYS.index.buildKey(grain, bucket, family));
  }
  for (const visitor of hour.visitors) {
    for (const view of visitor.views) {
      redisKeys.add(GROWTH_REDIS_KEYS.views.buildKey(grain, bucket, view.path));
      redisKeys.add(GROWTH_REDIS_KEYS.landings.buildKey(grain, bucket, view.path));
      redisKeys.add(
        GROWTH_REDIS_KEYS.campaignPaths.buildKey(grain, bucket, visitor.campaign, view.path)
      );
      const host = view.referrerHost;
      if (host !== undefined) {
        redisKeys.add(GROWTH_REDIS_KEYS.referrers.buildKey(grain, bucket, view.path, host));
      }
    }
  }
}

/** The day- and hour-keyed keys one visitor's own visit opens. */
function trackVisitorKeys(hourBucket: string, dayBucket: string, visitor: GrowthSeedVisitor): void {
  redisKeys.add(GROWTH_REDIS_KEYS.landing.buildKey(dayBucket, visitor.visitor));
  trackAddressKeys(dayBucket, visitor.addressId);
  const landing = visitor.views[0]?.path ?? '';
  for (const view of visitor.views) {
    redisKeys.add(GROWTH_REDIS_KEYS.reach.buildKey(dayBucket, landing, view.path));
  }
  for (const event of visitor.events) {
    redisKeys.add(
      GROWTH_REDIS_KEYS.events.buildKey(hourBucket, visitor.campaign, event.eventName, event.path)
    );
  }
}

/** Every key the plan's beacons and starts open, so this file deletes exactly what it wrote. */
function trackPlanKeys(plan: GrowthSeedPlan): void {
  for (const hour of plan.hours) {
    const hourBucket = growthHourBucket(hour.at);
    const dayBucket = growthDayBucket(hour.at);
    trackGrainKeys('h', hourBucket, hour);
    trackGrainKeys('d', dayBucket, hour);
    for (const visitor of hour.visitors) {
      trackVisitorKeys(hourBucket, dayBucket, visitor);
    }
    for (const start of hour.starts) {
      redisKeys.add(GROWTH_REDIS_KEYS.started.buildKey(hourBucket, start.campaign));
      redisKeys.add(GROWTH_REDIS_KEYS.startedDecoy.buildKey(hourBucket, start.campaign));
      trackAddressKeys(dayBucket, start.addressId);
    }
  }
}

/** The rows one case produced, by family. */
interface CaseRows {
  readonly visitors: (typeof growthVisitors.$inferSelect)[];
  readonly paths: (typeof growthPaths.$inferSelect)[];
  readonly referrers: (typeof growthReferrers.$inferSelect)[];
  readonly campaignPaths: (typeof growthCampaignPaths.$inferSelect)[];
  readonly geo: (typeof growthGeo.$inferSelect)[];
  readonly events: (typeof growthHourlyEvents.$inferSelect)[];
  readonly reach: (typeof growthDailyPathReach.$inferSelect)[];
  readonly funnel: (typeof growthHourlyFunnel.$inferSelect)[];
}

/**
 * Every growth row one case's own campaign, pages, host and buckets produced,
 * ordered so two runs compare row for row.
 *
 * Each family is read through a dimension of its own key that this file's
 * fixtures own — its labelled campaign, pages and referrer host — so no row
 * another writer put in the same bucket is ever read back here. The two
 * families whose key carries no such dimension, the bucket-global visitor
 * tally and the place tally, are read at this plan's own grain-and-bucket
 * coordinates instead, which is the narrowest scope their key shape allows: a
 * span over the day would take in every other bucket of that day, and an
 * hour-grain row at midnight sits inside it.
 */
async function rowsOf(subject: Case): Promise<CaseRows> {
  const firstHour = subject.hours[0];
  const lastHour = subject.hours.at(-1);
  const first = firstHour?.dayAt ?? new Date(0);
  const last = lastHour?.dayAt ?? new Date(0);
  const end = new Date(last.getTime() + DAY_MS);
  const span = (column: AnyPgColumn): ReturnType<typeof and> =>
    and(gte(column, first), lt(column, end));
  const ownBuckets = (grain: AnyPgColumn, bucket: AnyPgColumn): ReturnType<typeof or> =>
    or(
      ...subject.hours.flatMap(({ hourAt, dayAt }) => [
        and(eq(grain, 'hour'), eq(bucket, hourAt)),
        and(eq(grain, 'day'), eq(bucket, dayAt)),
      ])
    );
  return {
    visitors: await db
      .select()
      .from(growthVisitors)
      .where(ownBuckets(growthVisitors.grain, growthVisitors.bucket))
      .orderBy(growthVisitors.grain, growthVisitors.bucket),
    paths: await db
      .select()
      .from(growthPaths)
      .where(
        and(
          span(growthPaths.bucket),
          inArray(growthPaths.path, [subject.landingPath, subject.secondPath])
        )
      )
      .orderBy(growthPaths.grain, growthPaths.bucket, growthPaths.path),
    referrers: await db
      .select()
      .from(growthReferrers)
      .where(
        and(span(growthReferrers.bucket), eq(growthReferrers.referrerHost, subject.referrerHost))
      )
      .orderBy(growthReferrers.grain, growthReferrers.bucket, growthReferrers.path),
    campaignPaths: await db
      .select()
      .from(growthCampaignPaths)
      .where(eq(growthCampaignPaths.campaign, subject.campaign))
      .orderBy(growthCampaignPaths.grain, growthCampaignPaths.bucket, growthCampaignPaths.path),
    geo: await db
      .select()
      .from(growthGeo)
      .where(
        and(
          ownBuckets(growthGeo.grain, growthGeo.bucket),
          eq(growthGeo.country, HERE.country),
          eq(growthGeo.region, HERE.region),
          eq(growthGeo.device, HERE.device)
        )
      )
      .orderBy(growthGeo.grain, growthGeo.bucket),
    events: await db
      .select()
      .from(growthHourlyEvents)
      .where(eq(growthHourlyEvents.campaign, subject.campaign))
      .orderBy(growthHourlyEvents.hour, growthHourlyEvents.eventName),
    reach: await db
      .select()
      .from(growthDailyPathReach)
      .where(eq(growthDailyPathReach.landingPath, subject.landingPath))
      .orderBy(growthDailyPathReach.day, growthDailyPathReach.reachedPath),
    funnel: await db
      .select()
      .from(growthHourlyFunnel)
      .where(eq(growthHourlyFunnel.campaign, subject.campaign))
      .orderBy(growthHourlyFunnel.hour),
  };
}

describe('seedGrowthCounts', () => {
  it('mints every campaign the plan names before the rows that reference it are written', async () => {
    const subject = planOf(0, 1);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome.campaignsMinted).toBe(1);
    const rows = await db
      .select({ tag: campaigns.tag, status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.tag, subject.campaign));
    expect(rows).toEqual([{ tag: subject.campaign, status: 'active' }]);
  });

  it('rolls every planned hour and reports it', async () => {
    const subject = planOf(10, 2);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome.hoursRolled).toBe(2);
  });

  it('writes the day-grain rows of each planned hour’s own day', async () => {
    DAYS.requireSeededRows(await templateRowsOnSeededDay());
    const subject = planOf(SEEDED_SPAN, 1);
    const [hour] = subject.hours;

    await seedGrowthCounts({ db, redis }, subject.plan);

    const rows = await rowsOf(subject);
    // The visitor family's key is the grain and the bucket and nothing else, so
    // anyone counting a visitor in this bucket is a member of the same set: what
    // this plan owns is that its own two are in it, never that nobody else is.
    expect(rows.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', bucket: hour?.hourAt }),
      expect.objectContaining({ grain: 'day', bucket: hour?.dayAt }),
    ]);
    for (const row of rows.visitors) expect(row.visitors).toBeGreaterThanOrEqual(2);
    expect(rows.reach).toEqual([
      expect.objectContaining({ day: hour?.day, reachedPath: subject.landingPath, visitors: 2 }),
      expect.objectContaining({ day: hour?.day, reachedPath: subject.secondPath, visitors: 1 }),
    ]);
  });

  it('counts each planned view through the beacon writer, landings included', async () => {
    const subject = planOf(30, 1);

    await seedGrowthCounts({ db, redis }, subject.plan);

    const rows = await rowsOf(subject);
    expect(rows.paths).toEqual([
      expect.objectContaining({ grain: 'hour', path: subject.landingPath, landings: 2 }),
      expect.objectContaining({ grain: 'hour', path: subject.secondPath, landings: 0 }),
      expect.objectContaining({ grain: 'day', path: subject.landingPath, landings: 2 }),
      expect.objectContaining({ grain: 'day', path: subject.secondPath, landings: 0 }),
    ]);
    expect(rows.referrers).toEqual([
      expect.objectContaining({ grain: 'hour', referrerHost: subject.referrerHost, visitors: 1 }),
      expect.objectContaining({ grain: 'day', referrerHost: subject.referrerHost, visitors: 1 }),
    ]);
  });

  it('counts each planned named event under its own campaign and page', async () => {
    const subject = planOf(40, 1);

    await seedGrowthCounts({ db, redis }, subject.plan);

    const rows = await rowsOf(subject);
    expect(rows.events).toEqual([
      expect.objectContaining({
        eventName: ENTRY_EVENT,
        path: subject.landingPath,
        visitors: 1,
      }),
    ]);
  });

  it('counts each planned registration start through the published funnel door', async () => {
    const subject = planOf(50, 1);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    const rows = await rowsOf(subject);
    expect(outcome.startsCounted).toBe(1);
    expect(rows.funnel).toEqual([expect.objectContaining({ step: 'started', registrations: 1 })]);
  });

  it('leaves identical rows when the same plan is seeded twice', async () => {
    const subject = planOf(60, 2);
    await seedGrowthCounts({ db, redis }, subject.plan);
    const afterFirst = await rowsOf(subject);

    await seedGrowthCounts({ db, redis }, subject.plan);

    expect(await rowsOf(subject)).toEqual(afterFirst);
  });

  it('mints no campaign a second time', async () => {
    const subject = planOf(70, 1);
    await seedGrowthCounts({ db, redis }, subject.plan);

    const second = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(second.campaignsMinted).toBe(0);
  });

  it('latches no ceiling flag for a plan that stays under every ceiling', async () => {
    const subject = planOf(80, 2);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome.overflowLatched).toEqual([]);
    const rows = await rowsOf(subject);
    for (const table of Object.values(rows)) {
      expect(table).not.toContainEqual(expect.objectContaining({ overflow: true }));
    }
  });

  it('counts every beacon the plan names and fills no address budget', async () => {
    const subject = planOf(90, 1);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome).toMatchObject({ beaconsCounted: 4, addressBudgetsFilled: 0 });
  });

  it('refuses a beacon the address’s daily identity budget turned away', async () => {
    const subject = planOf(100, 1);
    const [hour] = subject.plan.hours;
    const [first, second] = hour?.visitors ?? [];
    if (hour === undefined || first === undefined || second === undefined) {
      throw new Error('the plan builder produced an hour this case cannot use');
    }
    // One address behind both visitors, under a budget of one identity: the
    // second identity is the one the ceiling has to turn away.
    const shared: GrowthSeedPlan = {
      ...subject.plan,
      hours: [
        {
          ...hour,
          visitors: [first, { ...second, addressId: first.addressId }],
        },
      ],
    };
    redisKeys.add(GROWTH_REDIS_KEYS.mint.buildKey(growthDayBucket(hour.at), first.addressId));

    await expect(
      seedGrowthCountsUnderCeilings({ db, redis }, shared, { ...GROWTH_CEILINGS, mint: 1 })
    ).rejects.toThrow('spread the plan’s visitors over more addresses'.replace('’', "'"));
  });

  it('reports the address whose whole daily identity budget the plan took', async () => {
    const subject = planOf(110, 1);

    const outcome = await seedGrowthCountsUnderCeilings({ db, redis }, subject.plan, {
      ...GROWTH_CEILINGS,
      mint: 1,
    });

    expect(outcome.addressBudgetsFilled).toBe(2);
  });

  it('reports the set a ceiling turned a member away from', async () => {
    const subject = planOf(120, 1);
    const [hour] = subject.plan.hours;
    if (hour === undefined) throw new Error('the plan builder produced no hour');
    const secondStart = { campaign: subject.campaign, addressId: callerOf() };
    redisKeys.add(
      GROWTH_REDIS_KEYS.mintCapped.buildKey(growthDayBucket(hour.at), secondStart.addressId)
    );
    // Two starts under a set that holds one: the second is the member the
    // ceiling turns away, which is what latches the flag.
    const crowded: GrowthSeedPlan = {
      ...subject.plan,
      hours: [{ ...hour, starts: [...hour.starts, secondStart] }],
    };

    const outcome = await seedGrowthCountsUnderCeilings({ db, redis }, crowded, {
      ...GROWTH_CEILINGS,
      set: 1,
    });

    expect(outcome.overflowLatched).toContain(
      `h:${GROWTH_REDIS_KEYS.started.setName(subject.campaign)}`
    );
  });

  it('refuses an hour the plan counted nothing in', async () => {
    const subject = planOf(130, 1);
    const [hour] = subject.plan.hours;
    if (hour === undefined) throw new Error('the plan builder produced no hour');
    const empty: GrowthSeedPlan = {
      ...subject.plan,
      hours: [{ ...hour, visitors: [], starts: [] }],
    };

    await expect(seedGrowthCounts({ db, redis }, empty)).rejects.toThrow('counted nothing');
  });

  it('refuses a campaign tag the mint door will not take', async () => {
    const subject = planOf(140, 1);
    const refused: GrowthSeedPlan = {
      ...subject.plan,
      campaigns: [{ tag: IDENTIFIER_SHAPED_TAG, label: 'a label nobody may mint under' }],
    };

    await expect(seedGrowthCounts({ db, redis }, refused)).rejects.toThrow('minting campaign');
  });

  /** The plan a refused mint fails on, so a case can read what the failure surfaced. */
  function refusedMint(dayIndex: number): GrowthSeedPlan {
    return {
      ...planOf(dayIndex, 1).plan,
      campaigns: [{ tag: IDENTIFIER_SHAPED_TAG, label: 'a label nobody may mint under' }],
    };
  }

  it('carries the failing step’s own message, not its code alone', async () => {
    const thrown: unknown = await seedGrowthCounts({ db, redis }, refusedMint(150)).catch(
      (error: unknown) => error
    );

    expect((thrown as Error).message).toContain('campaign tag is shaped like an identifier');
  });

  it('carries the failure itself as the thrown error’s cause', async () => {
    const thrown: unknown = await seedGrowthCounts({ db, redis }, refusedMint(160)).catch(
      (error: unknown) => error
    );

    expect((thrown as Error).cause).toEqual({
      code: 'validation',
      message: 'campaign tag is shaped like an identifier',
    });
  });

  // The seed is the one caller best placed to notice a counting store that lost
  // members: it counts a plan it knows and then rolls it, so a stored count
  // above what it just wrote can only have come from somewhere the plan does
  // not describe.
  it('reports the row whose landing count the re-roll had to lower', async () => {
    const subject = planOf(170, 1);
    const day = subject.hours[0];
    if (day === undefined) throw new Error('the plan builder produced no hour');
    await seedGrowthCounts({ db, redis }, subject.plan);
    await redis.del(GROWTH_REDIS_KEYS.landings.buildKey(DAY_GRAIN, day.day, subject.landingPath));
    await db
      .update(growthPaths)
      .set({ visitors: 12, landings: 5 })
      .where(
        and(
          eq(growthPaths.grain, 'day'),
          eq(growthPaths.bucket, day.dayAt),
          eq(growthPaths.path, subject.landingPath)
        )
      );

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome.landingsClamped).toEqual([`day ${day.day} ${subject.landingPath}`]);
  });

  it('reports no lowered row for a re-roll that lowered none', async () => {
    const subject = planOf(180, 1);

    const outcome = await seedGrowthCounts({ db, redis }, subject.plan);

    expect(outcome.landingsClamped).toEqual([]);
  });
});
