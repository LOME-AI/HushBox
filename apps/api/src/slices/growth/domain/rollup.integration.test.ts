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
  growthHourlyProductEntry,
  growthPaths,
  growthReferrers,
  growthVisitors,
  jobs,
} from '@hushbox/db';
import { GROWTH_CEILINGS, PRODUCT_ENTRY_ROUTES, productEntryEventNames } from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  growthDayBucket,
  growthHourBucket,
} from '../../../lib/redis/index.js';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
  jobWakesOf,
} from '../../../lib/jobs/index.js';
import { GROWTH_SEEDED_DAY_TABLE, growthTestDays } from '../../../test-support/growth-test-days.js';
import { countRegistrationStarted } from '../public/funnel.js';
import { countBeacon } from './count-beacon.js';
import { countRegistrationStartedUnderCeiling } from './count-registration-started.js';
import {
  GROWTH_ROLLUP_HOUR_LOST,
  GROWTH_ROLLUP_JOB_TYPE,
  GROWTH_ROLLUP_MARGIN_SECONDS,
  GROWTH_ROLLUP_WINDOW_HOURS,
  createGrowthRollupEnqueueEntry,
  createGrowthRollupJobRegistration,
  growthRollupWindow,
  rollupGrowthHour,
} from './rollup.js';
import type { GrowthCeilings } from './count-beacon.js';
import type { JobExecution } from '../../../lib/jobs/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for growth rollup integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** A client whose every call fails fast: nothing listens on the discard port. */
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const redisKeys = new Set<string>();
const seededTags: string[] = [];
const writtenDays: Date[] = [];
const enqueuedDedupeKeys: string[] = [];

afterAll(async () => {
  if (redisKeys.size > 0) await redis.del(...redisKeys);
  for (const day of writtenDays) {
    const next = new Date(day.getTime() + DAY_MS);
    const withinDay = and(gte(growthVisitors.bucket, day), lt(growthVisitors.bucket, next));
    await db.delete(growthVisitors).where(withinDay);
    await db
      .delete(growthPaths)
      .where(and(gte(growthPaths.bucket, day), lt(growthPaths.bucket, next)));
    await db
      .delete(growthReferrers)
      .where(and(gte(growthReferrers.bucket, day), lt(growthReferrers.bucket, next)));
    await db
      .delete(growthCampaignPaths)
      .where(and(gte(growthCampaignPaths.bucket, day), lt(growthCampaignPaths.bucket, next)));
    await db.delete(growthGeo).where(and(gte(growthGeo.bucket, day), lt(growthGeo.bucket, next)));
    await db
      .delete(growthHourlyEvents)
      .where(and(gte(growthHourlyEvents.hour, day), lt(growthHourlyEvents.hour, next)));
    await db
      .delete(growthHourlyFunnel)
      .where(and(gte(growthHourlyFunnel.hour, day), lt(growthHourlyFunnel.hour, next)));
    await db
      .delete(growthHourlyProductEntry)
      .where(and(gte(growthHourlyProductEntry.hour, day), lt(growthHourlyProductEntry.hour, next)));
    await db.delete(growthDailyPathReach).where(eq(growthDailyPathReach.day, growthDayBucket(day)));
  }
  if (seededTags.length > 0) {
    await db.delete(campaigns).where(inArray(campaigns.tag, seededTags));
  }
  for (const dedupeKey of enqueuedDedupeKeys) {
    await db.delete(jobs).where(eq(jobs.dedupeKey, dedupeKey));
  }
  await db.$client.end();
});

/** Records a Redis key so this file deletes exactly what it wrote and nothing else. */
function track(key: string): string {
  redisKeys.add(key);
  return key;
}

/** A short random label, so no two cases in this file can address one key or one tag. */
function label(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Sixteen random bytes as hex — the shape the beacon's day-keyed digest has. */
function visitorOf(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * One address's identities for one case, with the day's mint set and latch
 * tracked for deletion. Fresh per call, so no two cases share the ceiling that bounds
 * how many identities one address may mint in a day.
 */
function minterOf(day: string): { readonly mintId: string; readonly mintCappedId: string } {
  const mintId = `${visitorOf()}${visitorOf()}`;
  const mintCappedId = `${visitorOf()}${visitorOf()}`;
  track(GROWTH_REDIS_KEYS.mint.buildKey(day, mintId));
  track(GROWTH_REDIS_KEYS.mintCapped.buildKey(day, mintCappedId));
  return { mintId, mintCappedId };
}

/**
 * Where this file's cases sit, measured from the day the run is happening on.
 * The run day is what the placement has to be measured from: the ninety days
 * of growth rows the clone template carries are anchored to the day that
 * template's seed ran, and no fixed instant holds a chosen relationship to a
 * span that moves with the calendar.
 */
const DAYS = growthTestDays('rollup', new Date());

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

/**
 * A whole UTC day to itself per case: a bucket-global key — the visitor sets,
 * the index sets, the overflow hash — and a bucket-global ROW are both
 * addressed by the bucket and nothing else.
 */
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

interface Scene {
  /** The instant every beacon in the case arrives at. */
  readonly at: Date;
  readonly hour: string;
  readonly day: string;
  readonly hourAt: Date;
  readonly dayAt: Date;
  readonly campaign: string;
  readonly landingPath: string;
  readonly secondPath: string;
  readonly referrerHost: string;
  /** An auto-captured name carrying both `:` and `/`, the two characters the key template uses. */
  readonly eventName: string;
}

/** One case's own day, campaign tag and page names, seeded into `campaigns`. */
async function scene(dayIndex: number, hourOfDay: number): Promise<Scene> {
  const at = new Date(dayApart(dayIndex).getTime() + hourOfDay * HOUR_MS);
  const campaign = `roll-${label()}`;
  seededTags.push(campaign);
  writtenDays.push(dayApart(dayIndex));
  await db.insert(campaigns).values({ tag: campaign, label: campaign, status: 'active' });
  const suffix = label();
  return {
    at,
    hour: growthHourBucket(at),
    day: growthDayBucket(at),
    hourAt: new Date(`${growthHourBucket(at)}:00:00.000Z`),
    dayAt: new Date(`${growthDayBucket(at)}T00:00:00.000Z`),
    campaign,
    landingPath: `/land-${suffix}`,
    secondPath: `/next-${suffix}`,
    referrerHost: `news-${suffix}.example.com`,
    eventName: `link:/signup-${suffix}`,
  };
}

/**
 * The keys one scene's beacons open under the scene's own dimensions and
 * visitors, tracked so `afterAll` deletes them. The address-keyed keys those
 * beacons open are tracked where the address is minted, in {@link minterOf}.
 */
function trackSceneKeys(place: Scene, visitors: readonly string[]): void {
  const grains = [
    ['h', place.hour],
    ['d', place.day],
  ] as const;
  for (const [grain, bucket] of grains) {
    track(GROWTH_REDIS_KEYS.visitors.buildKey(grain, bucket));
    track(GROWTH_REDIS_KEYS.overflow.buildKey(grain, bucket));
    for (const path of [place.landingPath, place.secondPath]) {
      track(GROWTH_REDIS_KEYS.views.buildKey(grain, bucket, path));
      track(GROWTH_REDIS_KEYS.landings.buildKey(grain, bucket, path));
      track(GROWTH_REDIS_KEYS.referrers.buildKey(grain, bucket, path, place.referrerHost));
      track(GROWTH_REDIS_KEYS.campaignPaths.buildKey(grain, bucket, place.campaign, path));
    }
    track(GROWTH_REDIS_KEYS.geo.buildKey(grain, bucket, HERE));
    for (const family of ['paths', 'referrers', 'campaigns', 'geo', 'events', 'reach'] as const) {
      track(GROWTH_REDIS_KEYS.index.buildKey(grain, bucket, family));
    }
  }
  track(
    GROWTH_REDIS_KEYS.events.buildKey(
      place.hour,
      place.campaign,
      place.eventName,
      place.landingPath
    )
  );
  for (const reached of [place.landingPath, place.secondPath]) {
    track(GROWTH_REDIS_KEYS.reach.buildKey(place.day, place.landingPath, reached));
  }
  for (const visitor of visitors) {
    track(GROWTH_REDIS_KEYS.landing.buildKey(place.day, visitor));
  }
  track(GROWTH_REDIS_KEYS.started.buildKey(place.hour, place.campaign));
  track(GROWTH_REDIS_KEYS.startedDecoy.buildKey(place.hour, place.campaign));
}

/** The one place every case in this file counts from. */
const HERE = { country: 'US', region: 'CA', device: 'desktop' } as const;

/**
 * Two visitors on two pages under one campaign, one referrer, one event, one
 * landing and one reach — written through the beacon's own writer, so the
 * index-set encoding the rollup decodes is the encoding the beacon produced.
 */
async function seedBeacons(place: Scene): Promise<{ first: string; second: string }> {
  const first = visitorOf();
  const second = visitorOf();
  trackSceneKeys(place, [first, second]);
  const base = {
    path: place.landingPath,
    campaign: place.campaign,
    country: HERE.country,
    region: HERE.region,
    device: HERE.device,
    ...minterOf(place.day),
    at: place.at,
    ceilings: GROWTH_CEILINGS,
  } as const;

  const beacons = [
    {
      ...base,
      kind: 'view',
      referrerHost: place.referrerHost,
      eventName: undefined,
      visitor: first,
    },
    {
      ...base,
      kind: 'view',
      path: place.secondPath,
      referrerHost: undefined,
      eventName: undefined,
      visitor: first,
    },
    { ...base, kind: 'view', referrerHost: undefined, eventName: undefined, visitor: second },
    { ...base, kind: 'event', referrerHost: undefined, eventName: place.eventName, visitor: first },
  ] as const;

  for (const beacon of beacons) {
    const counted = await countBeacon(redis, beacon);
    expect(counted.isOk()).toBe(true);
  }
  return { first, second };
}

/**
 * The rolled rows of one scene, ordered so two runs compare row for row.
 *
 * A growth row is addressed by its own dimension tuple, and every read here is
 * scoped by the part of that tuple this file's fixtures own: a scene mints its
 * own campaign tag, its own two page names and its own referrer host, each
 * carrying a random label, so a family keyed on one of them answers with this
 * file's writes and nobody else's. The visitor and place families are keyed on
 * the bucket alone and on a place tuple any writer may use, so the most they can
 * be scoped to is this scene's own grain-and-bucket coordinates — a day SPAN
 * would take in every bucket of that day, an hour-grain row at midnight
 * included, which is another writer's row whenever the day is one a seed
 * reached. What those two families' tallies may then be asserted as is a floor:
 * a bucket-global set takes every writer's members, and a member this file did
 * not write can only raise the count.
 */
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

async function rowsOf(place: Scene): Promise<CaseRows> {
  return {
    visitors: await db
      .select()
      .from(growthVisitors)
      .where(
        or(
          and(eq(growthVisitors.grain, 'hour'), eq(growthVisitors.bucket, place.hourAt)),
          and(eq(growthVisitors.grain, 'day'), eq(growthVisitors.bucket, place.dayAt))
        )
      )
      .orderBy(growthVisitors.grain, growthVisitors.bucket),
    paths: await db
      .select()
      .from(growthPaths)
      .where(inArray(growthPaths.path, [place.landingPath, place.secondPath]))
      .orderBy(growthPaths.grain, growthPaths.bucket, growthPaths.path),
    referrers: await db
      .select()
      .from(growthReferrers)
      .where(eq(growthReferrers.referrerHost, place.referrerHost))
      .orderBy(growthReferrers.grain, growthReferrers.bucket, growthReferrers.path),
    campaignPaths: await db
      .select()
      .from(growthCampaignPaths)
      .where(eq(growthCampaignPaths.campaign, place.campaign))
      .orderBy(growthCampaignPaths.grain, growthCampaignPaths.bucket, growthCampaignPaths.path),
    geo: await db
      .select()
      .from(growthGeo)
      .where(
        and(
          or(
            and(eq(growthGeo.grain, 'hour'), eq(growthGeo.bucket, place.hourAt)),
            and(eq(growthGeo.grain, 'day'), eq(growthGeo.bucket, place.dayAt))
          ),
          eq(growthGeo.country, HERE.country),
          eq(growthGeo.region, HERE.region),
          eq(growthGeo.device, HERE.device)
        )
      )
      .orderBy(growthGeo.grain, growthGeo.bucket),
    events: await db
      .select()
      .from(growthHourlyEvents)
      .where(eq(growthHourlyEvents.campaign, place.campaign))
      .orderBy(growthHourlyEvents.hour, growthHourlyEvents.eventName),
    // Scoped by the landing page rather than by the day, so the day column the
    // rows carry is still something a case can assert rather than something the
    // query already fixed.
    reach: await db
      .select()
      .from(growthDailyPathReach)
      .where(eq(growthDailyPathReach.landingPath, place.landingPath))
      .orderBy(growthDailyPathReach.landingPath, growthDailyPathReach.reachedPath),
    funnel: await db
      .select()
      .from(growthHourlyFunnel)
      .where(eq(growthHourlyFunnel.campaign, place.campaign))
      .orderBy(growthHourlyFunnel.hour),
  };
}

/** The day-grain path rows of one scene, typed by the select rather than cast out of a wider read. */
async function dayPathRows(
  place: Scene
): Promise<{ path: string; visitors: number; landings: number }[]> {
  return db
    .select({
      path: growthPaths.path,
      visitors: growthPaths.visitors,
      landings: growthPaths.landings,
    })
    .from(growthPaths)
    .where(
      and(
        eq(growthPaths.grain, 'day'),
        eq(growthPaths.bucket, place.dayAt),
        inArray(growthPaths.path, [place.landingPath, place.secondPath])
      )
    )
    .orderBy(growthPaths.path);
}

/** The day-grain visitor row of one bucket, which is at most one by its own unique tuple. */
async function dayVisitorRows(bucket: Date): Promise<(typeof growthVisitors.$inferSelect)[]> {
  return db
    .select()
    .from(growthVisitors)
    .where(and(eq(growthVisitors.grain, 'day'), eq(growthVisitors.bucket, bucket)));
}

/**
 * The row set a rollup that wrote nothing leaves behind.
 *
 * The six families keyed on a dimension this scene owns hold no row at all,
 * which is exact. The visitor and place families are keyed on the bucket alone,
 * so a day another writer reached already holds their rows before this case
 * starts: what a rollup writing nothing can be held to there is that it left
 * them as it found them, which is why `untouched` is read before the run.
 */
function nothingWritten(untouched: CaseRows): CaseRows {
  return {
    visitors: untouched.visitors,
    geo: untouched.geo,
    paths: [],
    referrers: [],
    campaignPaths: [],
    events: [],
    reach: [],
    funnel: [],
  };
}

/** What a bucket-global family's tally may be asserted as: a floor, never a total. */
function expectAtLeast(rows: readonly { readonly visitors: number }[], least: number): void {
  for (const row of rows) expect(row.visitors).toBeGreaterThanOrEqual(least);
}

/**
 * The day grain as a key template spells it. Named rather than written into the
 * call below, because what a test's key takes from this file is its identity —
 * here the scene's own random day and page — and the grain is neither of those.
 */
const DAY_GRAIN = 'd';

/** The hour grain, for the same reason. */
const HOUR_GRAIN = 'h';

/** The day-grain view and landing sets of one page, removed exactly as their own expiry removes them. */
async function expireDaySets(place: Scene, path: string): Promise<void> {
  await redis.del(
    GROWTH_REDIS_KEYS.views.buildKey(DAY_GRAIN, place.day, path),
    GROWTH_REDIS_KEYS.landings.buildKey(DAY_GRAIN, place.day, path)
  );
}

/**
 * The day-grain landing set of one page alone, removed the way its own expiry
 * removes it — with the view set beside it left standing, which is the state
 * the two lifetimes reach on their own: every view extends the view set, while
 * only a new visitor's first sight of the day extends the landing set.
 */
async function expireDayLandings(place: Scene, path: string): Promise<void> {
  await redis.del(GROWTH_REDIS_KEYS.landings.buildKey(DAY_GRAIN, place.day, path));
}

/**
 * The hour-grain landing set of one page alone, removed the way its own expiry
 * removes it. The same two lifetimes as {@link expireDayLandings}, at the grain
 * whose set is the shorter-lived of the two and so the first to leave a row
 * behind it.
 */
async function expireHourLandings(place: Scene, path: string): Promise<void> {
  await redis.del(GROWTH_REDIS_KEYS.landings.buildKey(HOUR_GRAIN, place.hour, path));
}

/**
 * The bucket's day-grain overflow flags, removed the way their own expiry
 * removes them — with every set left standing, which is again the state the two
 * lifetimes reach on their own: an admitted add extends a set even when it only
 * re-adds a member it already holds, while only a genuine refusal extends the
 * flags.
 */
async function expireDayOverflow(place: Scene): Promise<void> {
  await redis.del(GROWTH_REDIS_KEYS.overflow.buildKey(DAY_GRAIN, place.day));
}

/**
 * The bucket's hour-grain overflow flags, removed the way their own expiry
 * removes them. Same two lifetimes as {@link expireDayOverflow}, at the grain
 * the registration-start set is counted in.
 */
async function expireHourOverflow(place: Scene): Promise<void> {
  await redis.del(GROWTH_REDIS_KEYS.overflow.buildKey(HOUR_GRAIN, place.hour));
}

/** One page view by one visitor at the scene's own instant, place and campaign. */
async function viewBeacon(
  place: Scene,
  visitor: string,
  path: string,
  ceilings: GrowthCeilings
): Promise<void> {
  const counted = await countBeacon(redis, {
    kind: 'view',
    path,
    referrerHost: undefined,
    campaign: place.campaign,
    eventName: undefined,
    country: HERE.country,
    region: HERE.region,
    device: HERE.device,
    visitor,
    ...minterOf(place.day),
    at: place.at,
    ceilings,
  });
  expect(counted.isOk()).toBe(true);
}

/**
 * One name a marketing anchor into the product fires under, taken from the
 * derivation the beacon decides by rather than spelled here — a literal would
 * be a second spelling of the name the beacon stores, and the two would have to
 * agree for the case to mean anything.
 */
function entryEventName(): string {
  const [name] = productEntryEventNames(PRODUCT_ENTRY_ROUTES);
  if (name === undefined) {
    throw new Error('no product-entry event name derives from the product entry routes');
  }
  return name;
}

/**
 * One product-entry click by one visitor under one campaign, at the scene's own
 * instant and page, with the keys it opens tracked for deletion. The campaign
 * is a parameter because the point of these cases is one visitor arriving under
 * more than one of them.
 */
async function entryClickBeacon(place: Scene, campaign: string, visitor: string): Promise<void> {
  const eventName = entryEventName();
  track(GROWTH_REDIS_KEYS.productEntry.buildKey(place.hour));
  track(GROWTH_REDIS_KEYS.events.buildKey(place.hour, campaign, eventName, place.landingPath));
  track(GROWTH_REDIS_KEYS.index.buildKey(HOUR_GRAIN, place.hour, 'events'));
  track(GROWTH_REDIS_KEYS.visitors.buildKey(HOUR_GRAIN, place.hour));
  track(GROWTH_REDIS_KEYS.visitors.buildKey(DAY_GRAIN, place.day));
  track(GROWTH_REDIS_KEYS.overflow.buildKey(HOUR_GRAIN, place.hour));
  track(GROWTH_REDIS_KEYS.overflow.buildKey(DAY_GRAIN, place.day));
  const counted = await countBeacon(redis, {
    kind: 'event',
    path: place.landingPath,
    referrerHost: undefined,
    campaign,
    eventName,
    country: HERE.country,
    region: HERE.region,
    device: HERE.device,
    visitor,
    ...minterOf(place.day),
    at: place.at,
    ceilings: GROWTH_CEILINGS,
  });
  expect(counted.isOk()).toBe(true);
}

/** A second campaign tag on the scene's own day, so one visitor can arrive under two. */
async function secondCampaign(): Promise<string> {
  const campaign = `roll-${label()}`;
  seededTags.push(campaign);
  await db.insert(campaigns).values({ tag: campaign, label: campaign, status: 'active' });
  return campaign;
}

/** The product-entry rows of one scene's hour, which is at most one by the table's own unique hour. */
async function productEntryRowsOf(
  place: Scene
): Promise<(typeof growthHourlyProductEntry.$inferSelect)[]> {
  return db
    .select()
    .from(growthHourlyProductEntry)
    .where(eq(growthHourlyProductEntry.hour, place.hourAt));
}

/** A ceiling one more member cannot fit under, leaving every other ceiling as it is. */
const SET_FULL_AT_TWO: GrowthCeilings = { ...GROWTH_CEILINGS, set: 2 };

/** A visitor new to the scene's day, with the landing key its first view claims tracked for deletion. */
function arriving(place: Scene): string {
  const visitor = visitorOf();
  track(GROWTH_REDIS_KEYS.landing.buildKey(place.day, visitor));
  return visitor;
}

function executionFor(hour: string): JobExecution<{ hour: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { hour },
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

interface Recorder {
  readonly telemetry: Telemetry;
  readonly captures: { error: unknown; code: string }[];
}

/** A telemetry that keeps what it was handed, so a case can read what a run reported. */
function recordingTelemetry(): Recorder {
  const captures: Recorder['captures'] = [];
  return {
    captures,
    telemetry: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      captureError: (error: unknown, code: string) => {
        captures.push({ error, code });
      },
    },
  };
}

function registrationFor(
  now: () => Date,
  telemetry: Telemetry = recordingTelemetry().telemetry
): ReturnType<typeof createGrowthRollupJobRegistration> {
  return createGrowthRollupJobRegistration({
    db,
    resolveRedis: () => redis,
    resolveTelemetry: () => telemetry,
    now,
  });
}

describe('rollupGrowthHour', () => {
  it('assigns one row per counted set and leaves identical rows when the hour is rolled twice', async () => {
    const place = await scene(0, 9);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);
    const registration = registrationFor(() => now);

    const first = await registration.handler(executionFor(place.hour));
    expect(first).toEqual({
      kind: 'ok',
      result: {
        hour: place.hour,
        rows: {
          visitors: 2,
          paths: 4,
          referrers: 2,
          campaignPaths: 4,
          geo: 2,
          events: 1,
          productEntry: 0,
          reach: 2,
          funnel: 0,
        },
      },
    });
    const afterFirst = await rowsOf(place);

    const second = await registration.handler(executionFor(place.hour));
    expect(second).toEqual(first);
    expect(await rowsOf(place)).toEqual(afterFirst);

    // The grain column is a pgEnum, so `order by grain` is its declaration
    // order — hour before day — not alphabetical.
    expect(afterFirst.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', bucket: place.hourAt, overflow: false }),
      expect.objectContaining({ grain: 'day', bucket: place.dayAt, overflow: false }),
    ]);
    expectAtLeast(afterFirst.visitors, 2);
    expect(afterFirst.paths).toEqual([
      expect.objectContaining({
        grain: 'hour',
        path: place.landingPath,
        visitors: 2,
        landings: 2,
      }),
      expect.objectContaining({ grain: 'hour', path: place.secondPath, visitors: 1, landings: 0 }),
      expect.objectContaining({
        grain: 'day',
        path: place.landingPath,
        visitors: 2,
        landings: 2,
      }),
      expect.objectContaining({ grain: 'day', path: place.secondPath, visitors: 1, landings: 0 }),
    ]);
    expect(afterFirst.referrers).toEqual([
      expect.objectContaining({
        grain: 'hour',
        path: place.landingPath,
        referrerHost: place.referrerHost,
        visitors: 1,
      }),
      expect.objectContaining({
        grain: 'day',
        path: place.landingPath,
        referrerHost: place.referrerHost,
        visitors: 1,
      }),
    ]);
    expect(afterFirst.campaignPaths).toEqual([
      expect.objectContaining({ grain: 'hour', path: place.landingPath, visitors: 2 }),
      expect.objectContaining({ grain: 'hour', path: place.secondPath, visitors: 1 }),
      expect.objectContaining({ grain: 'day', path: place.landingPath, visitors: 2 }),
      expect.objectContaining({ grain: 'day', path: place.secondPath, visitors: 1 }),
    ]);
    expect(afterFirst.geo).toEqual([
      expect.objectContaining({ grain: 'hour', bucket: place.hourAt, country: 'US', region: 'CA' }),
      expect.objectContaining({ grain: 'day', bucket: place.dayAt, country: 'US', region: 'CA' }),
    ]);
    expectAtLeast(afterFirst.geo, 2);
    expect(afterFirst.reach).toEqual([
      expect.objectContaining({
        landingPath: place.landingPath,
        reachedPath: place.landingPath,
        visitors: 2,
      }),
      expect.objectContaining({
        landingPath: place.landingPath,
        reachedPath: place.secondPath,
        visitors: 1,
      }),
    ]);
  });

  // The event name carries `:` and `/`, the two characters the key template
  // spells its own boundaries with. A rollup that recovered dimensions by
  // splitting on either would file this count under a name nobody wrote.
  it('keeps an event name that carries the key template’s own delimiters intact', async () => {
    const place = await scene(1, 5);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(rolled.isOk()).toBe(true);

    const rows = await rowsOf(place);
    expect(rows.events).toEqual([
      expect.objectContaining({
        hour: place.hourAt,
        campaign: place.campaign,
        eventName: place.eventName,
        path: place.landingPath,
        visitors: 1,
      }),
    ]);
  });

  // The whole reason the marginal is counted at all: set cardinalities are not
  // additive across a dimension, so one person who entered the product under
  // two tags is one entrant and two campaign rows, and the unscoped figure
  // cannot be recovered by adding the scoped ones up.
  it('counts a visitor who entered the product under two campaigns once where the campaign rows sum to two', async () => {
    const place = await scene(21, 6);
    const otherCampaign = await secondCampaign();
    const visitor = arriving(place);
    await entryClickBeacon(place, place.campaign, visitor);
    await entryClickBeacon(place, otherCampaign, visitor);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled.isOk()).toBe(true);

    expect(await productEntryRowsOf(place)).toEqual([
      expect.objectContaining({ hour: place.hourAt, visitors: 1, overflow: false }),
    ]);
    const perCampaign = await db
      .select()
      .from(growthHourlyEvents)
      .where(inArray(growthHourlyEvents.campaign, [place.campaign, otherCampaign]));
    expect(perCampaign.map((row) => row.visitors)).toEqual([1, 1]);
  });

  // Both marginals come out of one pass over one hour, so a rolled hour that
  // holds one holds the other: they are read from two keys and written inside
  // the one transaction.
  it('writes the campaign-free click count in the same rolled hour as the campaign-free visitor count', async () => {
    const place = await scene(22, 6);
    const visitor = arriving(place);
    await entryClickBeacon(place, place.campaign, visitor);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled.isOk()).toBe(true);

    const visitors = await db
      .select()
      .from(growthVisitors)
      .where(and(eq(growthVisitors.grain, 'hour'), eq(growthVisitors.bucket, place.hourAt)));
    expect(visitors).toEqual([
      expect.objectContaining({ grain: 'hour', bucket: place.hourAt, visitors: 1 }),
    ]);
    expect(await productEntryRowsOf(place)).toEqual([
      expect.objectContaining({ hour: place.hourAt, visitors: 1 }),
    ]);
  });

  // The transaction is what makes that pairing hold under a failure too: a
  // refusal at any write leaves the hour with neither marginal rather than with
  // the one whose insert ran first.
  it('leaves neither marginal behind when one of the hour’s writes is refused', async () => {
    const place = await scene(23, 6);
    const visitor = arriving(place);
    await entryClickBeacon(place, place.campaign, visitor);
    // The campaign row the counted event references, removed after the beacon
    // landed: the event write then violates its foreign key, which is a refusal
    // arriving after the two marginals have already been written to.
    await db.delete(campaigns).where(eq(campaigns.tag, place.campaign));

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled._unsafeUnwrapErr().code).toBe('unavailable');

    const visitors = await db
      .select()
      .from(growthVisitors)
      .where(and(eq(growthVisitors.grain, 'hour'), eq(growthVisitors.bucket, place.hourAt)));
    expect(visitors).toEqual([]);
    expect(await productEntryRowsOf(place)).toEqual([]);
  });

  it('counts the registration starts and never the decoy set beside them', async () => {
    const place = await scene(2, 3);
    await seedBeacons(place);
    const started = {
      secret: 'a-growth-hash-secret-of-at-least-32-chars',
      at: place.at,
      campaign: place.campaign,
      decoy: false,
    };
    const real = await countRegistrationStarted(redis, { ...started, address: '198.51.100.1' });
    expect(real.isOk()).toBe(true);
    const decoy = await countRegistrationStarted(redis, {
      ...started,
      decoy: true,
      address: '198.51.100.2',
    });
    expect(decoy.isOk()).toBe(true);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled._unsafeUnwrap()).toEqual(
      expect.objectContaining({ kind: 'rolled', rows: expect.objectContaining({ funnel: 1 }) })
    );

    const rows = await rowsOf(place);
    expect(rows.funnel).toEqual([
      expect.objectContaining({
        hour: place.hourAt,
        campaign: place.campaign,
        step: 'started',
        registrations: 1,
      }),
    ]);
  });

  /**
   * Two starts under a ceiling of one, so the second is refused and latches the
   * set's own field on the hour bucket. The ceiling is a parameter here for the
   * same reason it is one on the beacon: driving the real one would mean a
   * hundred thousand addresses.
   */
  async function startTwiceUnderACeilingOfOne(place: Scene): Promise<void> {
    track(GROWTH_REDIS_KEYS.started.buildKey(place.hour, place.campaign));
    for (const addressId of [visitorOf() + visitorOf(), visitorOf() + visitorOf()]) {
      const counted = await countRegistrationStartedUnderCeiling(
        redis,
        { hour: place.hour, campaign: place.campaign, addressId, decoy: false },
        1
      );
      expect(counted.isOk()).toBe(true);
    }
  }

  // The registration-start set is bounded like every other growth set, so its
  // row carries the same floor mark the beacon families' rows carry, copied
  // from the same hour bucket by the same guard.
  it('copies the started set’s ceiling flag onto the funnel row', async () => {
    const place = await scene(20, 5);
    await seedBeacons(place);
    await startTwiceUnderACeilingOfOne(place);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled.isOk()).toBe(true);

    const rows = await rowsOf(place);
    // The count stays what the set holds: the refused address is not counted,
    // and the flag is what says the number is a floor.
    expect(rows.funnel).toEqual([
      expect.objectContaining({
        hour: place.hourAt,
        campaign: place.campaign,
        step: 'started',
        registrations: 1,
        overflow: true,
      }),
    ]);
  });

  // The absent-key ruling reaches this column as it reaches the others: an hour
  // bucket holding no flags no longer knows whether the set filled, which is
  // not the same fact as knowing it did not.
  it('keeps the funnel row’s flag once the hour bucket holds no flags', async () => {
    DAYS.requireSeededRows(await templateRowsOnSeededDay());
    const place = await scene(SEEDED_SPAN, 5);
    await seedBeacons(place);
    await startTwiceUnderACeilingOfOne(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const first = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(first.isOk()).toBe(true);
    const flagged = await rowsOf(place);
    expect(flagged.funnel).toEqual([expect.objectContaining({ registrations: 1, overflow: true })]);

    await expireHourOverflow(place);

    const second = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(second.isOk()).toBe(true);
    expect(await rowsOf(place)).toEqual(flagged);
  });

  // A day-grain row belongs to the ROLLED hour's day, not to the day the job
  // happens to run in: the run for hour 23 fires after midnight.
  it('files the day row for the last hour of a day on that day', async () => {
    const place = await scene(3, 23);
    await seedBeacons(place);
    const nextDay = new Date(place.dayAt.getTime() + DAY_MS);
    // The next day's own row set, read before the rollup: the visitor family is
    // bucket-global, so what this case can claim about a day it wrote nothing
    // to is that the rollup left it exactly as it found it — asserting the day
    // holds no row at all would be a claim about every other writer's rows too.
    const nextDayBefore = await dayVisitorRows(nextDay);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(nextDay.getTime() + HOUR_MS),
    });
    expect(rolled.isOk()).toBe(true);

    const rows = await rowsOf(place);
    expect(rows.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', bucket: place.hourAt }),
      expect.objectContaining({ grain: 'day', bucket: place.dayAt }),
    ]);
    expect(rows.reach).toEqual([
      expect.objectContaining({ day: place.day }),
      expect.objectContaining({ day: place.day }),
    ]);
    expect(await dayVisitorRows(nextDay)).toEqual(nextDayBefore);
  });

  // Every count this rollup writes is the cardinality of a ceiling-bounded set,
  // so every table it writes carries the flag, and the rollup raises it on
  // exactly the rows whose own set refused a member — the flag beside a count
  // is that count's set's own field on the bucket it was counted in, never
  // evidence about a set beside it.
  it('copies each set’s ceiling flag onto the rows that set filled', async () => {
    const place = await scene(8, 7);
    await seedBeacons(place);
    // One more visitor on the landing page, under a ceiling the sets it would
    // join have already reached: the write script refuses the member and
    // latches the flag on exactly those sets, leaving the second page's sets
    // untouched.
    const refused = await countBeacon(redis, {
      kind: 'view',
      path: place.landingPath,
      referrerHost: undefined,
      campaign: place.campaign,
      eventName: undefined,
      country: HERE.country,
      region: HERE.region,
      device: HERE.device,
      visitor: visitorOf(),
      ...minterOf(place.day),
      at: place.at,
      ceilings: { ...GROWTH_CEILINGS, set: 2 },
    });
    expect(refused.isOk()).toBe(true);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled.isOk()).toBe(true);

    const rows = await rowsOf(place);
    expect(rows.paths).toEqual([
      expect.objectContaining({ grain: 'hour', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'hour', path: place.secondPath, overflow: false }),
      expect.objectContaining({ grain: 'day', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'day', path: place.secondPath, overflow: false }),
    ]);
    expect(rows.campaignPaths).toEqual([
      expect.objectContaining({ grain: 'hour', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'hour', path: place.secondPath, overflow: false }),
      expect.objectContaining({ grain: 'day', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'day', path: place.secondPath, overflow: false }),
    ]);
    expect(rows.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', overflow: true }),
      expect.objectContaining({ grain: 'day', overflow: true }),
    ]);
    // The count stays what the set holds: a refused member is not counted, and
    // the flag is what says the number is a floor.
    expect(rows.geo).toEqual([
      expect.objectContaining({ grain: 'hour', overflow: true }),
      expect.objectContaining({ grain: 'day', overflow: true }),
    ]);
    expectAtLeast(rows.geo, 2);
    // The refused visitor had already landed on the landing page, so the pair
    // they would have joined is the one that filled; the journey on to the
    // second page was made by a visitor the set still holds.
    expect(rows.reach).toEqual([
      expect.objectContaining({ reachedPath: place.landingPath, overflow: true }),
      expect.objectContaining({ reachedPath: place.secondPath, overflow: false }),
    ]);
  });

  // A family's index set is extended by every write to the family, a single
  // value's set only by writes naming that value, so the index outlives its
  // members whenever one page stops receiving traffic before the day does. The
  // reading of zero that leaves behind means the counting store no longer
  // holds the set, never that nobody came, and these rows are kept forever.
  it('leaves a rolled row alone once the counting store no longer holds that value’s set', async () => {
    const place = await scene(12, 8);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const first = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(first._unsafeUnwrap()).toEqual(
      expect.objectContaining({ kind: 'rolled', rows: expect.objectContaining({ paths: 4 }) })
    );
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);

    await expireDaySets(place, place.secondPath);

    const second = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(second._unsafeUnwrap()).toEqual(
      expect.objectContaining({ kind: 'rolled', rows: expect.objectContaining({ paths: 3 }) })
    );
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);
  });

  // The other direction of the same rule: dropping a row is not latching one
  // out. A value the index names writes no row while its set is gone, and the
  // first run that finds the set back writes the row it holds.
  it('writes the row for an unbacked value as soon as its set comes back', async () => {
    const place = await scene(13, 8);
    const { second: returning } = await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);
    await expireDaySets(place, place.secondPath);

    const before = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(before.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
    ]);

    const returned = await countBeacon(redis, {
      kind: 'view',
      path: place.secondPath,
      referrerHost: undefined,
      campaign: place.campaign,
      eventName: undefined,
      country: HERE.country,
      region: HERE.region,
      device: HERE.device,
      visitor: returning,
      ...minterOf(place.day),
      at: place.at,
      ceilings: GROWTH_CEILINGS,
    });
    expect(returned.isOk()).toBe(true);

    const after = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(after.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);
  });

  // The view set and the landing set fill one row and do not die together: a
  // view extends the view set, while only a new visitor's first sight of the
  // day extends the landing set, so the landing set is the one that goes first.
  // The zero it answers with in the window between the two deaths means the
  // store no longer holds it, never that nobody landed.
  it('keeps the rolled landing count once the counting store no longer holds the landing set', async () => {
    const place = await scene(16, 8);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const first = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(first.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);

    await expireDayLandings(place, place.landingPath);

    const second = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(second.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 2 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);
  });

  // The other direction of the same rule: leaving a column alone is not
  // latching it out. A row inserted with no landing evidence behind it takes
  // the count again from the first run that finds the set.
  it('writes the landing count again as soon as the landing set comes back', async () => {
    const place = await scene(17, 8);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);
    await expireDayLandings(place, place.landingPath);

    const before = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(before.isOk()).toBe(true);
    // Nothing earlier wrote this row, so there is no earlier value to keep and
    // the column takes what a row with no landings means.
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 2, landings: 0 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);

    await viewBeacon(place, arriving(place), place.landingPath, GROWTH_CEILINGS);

    const after = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(after.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 3, landings: 1 },
      { path: place.secondPath, visitors: 1, landings: 0 },
    ]);
  });

  // A bucket whose sets lost members the rows outlived — a store recreated
  // without its data, an eviction, a flush — reads back a visitor count below
  // the landing count the row already holds. The row then has to be brought
  // back inside `landings <= visitors`, which is the one relationship the table
  // refuses to hold a row outside of.
  it('writes an accepted row when a re-roll reads fewer visitors than the stored landing count', async () => {
    const place = await scene(24, 8);
    const visitor = arriving(place);
    trackSceneKeys(place, [visitor]);
    await viewBeacon(place, visitor, place.landingPath, GROWTH_CEILINGS);
    await expireDayLandings(place, place.landingPath);
    await db.insert(growthPaths).values({
      grain: 'day',
      bucket: place.dayAt,
      path: place.landingPath,
      visitors: 12,
      landings: 2,
    });
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });

    expect(rolled.isOk()).toBe(true);
    expect(await dayPathRows(place)).toEqual([
      { path: place.landingPath, visitors: 1, landings: 1 },
    ]);
  });

  it('names the lowered row in the outcome of the re-roll that lowered it', async () => {
    const place = await scene(25, 8);
    const visitor = arriving(place);
    trackSceneKeys(place, [visitor]);
    await viewBeacon(place, visitor, place.landingPath, GROWTH_CEILINGS);
    await expireDayLandings(place, place.landingPath);
    await db.insert(growthPaths).values({
      grain: 'day',
      bucket: place.dayAt,
      path: place.landingPath,
      visitors: 12,
      landings: 2,
    });
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });

    expect(rolled._unsafeUnwrap()).toEqual(
      expect.objectContaining({
        kind: 'rolled',
        clamped: [{ grain: 'day', bucket: place.day, path: place.landingPath }],
      })
    );
  });

  // The same loss one grain up. Both grains' rows run through the one clamp, so
  // the bucket it reports is the row's own — and an hour row whose landing set
  // has expired reads back exactly as a day row does, with the day's own set
  // left standing so the day row is not what this case is watching.
  it('names the lowered hour row against the hour bucket it was lowered in', async () => {
    const place = await scene(28, 8);
    const visitor = arriving(place);
    trackSceneKeys(place, [visitor]);
    await viewBeacon(place, visitor, place.landingPath, GROWTH_CEILINGS);
    await expireHourLandings(place, place.landingPath);
    await db.insert(growthPaths).values({
      grain: 'hour',
      bucket: place.hourAt,
      path: place.landingPath,
      visitors: 12,
      landings: 2,
    });
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });

    expect(rolled._unsafeUnwrap()).toEqual(
      expect.objectContaining({
        kind: 'rolled',
        clamped: [{ grain: 'hour', bucket: place.hour, path: place.landingPath }],
      })
    );
  });

  it('names no lowered row in the outcome of a re-roll that lowered none', async () => {
    const place = await scene(14, 8);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });

    expect(rolled._unsafeUnwrap()).toEqual(
      expect.objectContaining({ kind: 'rolled', clamped: [] })
    );
  });

  // The reproduction with its one difference: the landing set is still there,
  // so the reading carries a count of its own. The stored count stands above
  // the visitors being written exactly as it does there, so the store is not
  // what decides this — the reading is. A fresh observation is never stale, and
  // a count the reading brought is not a loss to report.
  it('names no lowered row where the reading carries a landing count of its own', async () => {
    const place = await scene(26, 8);
    const visitor = arriving(place);
    trackSceneKeys(place, [visitor]);
    await viewBeacon(place, visitor, place.landingPath, GROWTH_CEILINGS);
    await db.insert(growthPaths).values({
      grain: 'day',
      bucket: place.dayAt,
      path: place.landingPath,
      visitors: 12,
      landings: 2,
    });
    const now = new Date(place.at.getTime() + HOUR_MS);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });

    expect(rolled._unsafeUnwrap()).toEqual(
      expect.objectContaining({ kind: 'rolled', clamped: [] })
    );
  });

  // The bucket's flags and its sets do not die together either: an admitted add
  // extends a set even when it only re-adds a member the set already holds,
  // while only a genuine refusal extends the flags. So the flags go first, and
  // their absence means the store no longer knows whether the set filled —
  // which is not the same fact as knowing it did not.
  it('keeps the rolled overflow flag once the counting store no longer holds the bucket’s flags', async () => {
    const place = await scene(18, 7);
    await seedBeacons(place);
    await viewBeacon(place, arriving(place), place.landingPath, SET_FULL_AT_TWO);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const first = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(first.isOk()).toBe(true);
    const flagged = await rowsOf(place);
    expect(flagged.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', overflow: true }),
      expect.objectContaining({ grain: 'day', overflow: true }),
    ]);
    expect(flagged.paths).toEqual([
      expect.objectContaining({ grain: 'hour', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'hour', path: place.secondPath, overflow: false }),
      expect.objectContaining({ grain: 'day', path: place.landingPath, overflow: true }),
      expect.objectContaining({ grain: 'day', path: place.secondPath, overflow: false }),
    ]);
    // Named here so the row-for-row comparison below is not vacuous for the
    // journey table: a flag it never carried could not be lost.
    expect(flagged.reach).toEqual([
      expect.objectContaining({ reachedPath: place.landingPath, overflow: true }),
      expect.objectContaining({ reachedPath: place.secondPath, overflow: false }),
    ]);

    // Only the day grain's flags go, so the hour rows stand as the control: a
    // run that assigned the absence would turn the day rows false beside them.
    await expireDayOverflow(place);

    const second = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(second.isOk()).toBe(true);
    expect(await rowsOf(place)).toEqual(flagged);
  });

  // The other direction again: a row written while the bucket held no flags at
  // all takes the flag from the first run that finds one.
  it('raises the overflow flag as soon as the bucket’s flags come back', async () => {
    const place = await scene(19, 7);
    await seedBeacons(place);
    const now = new Date(place.at.getTime() + HOUR_MS);

    const before = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(before.isOk()).toBe(true);
    // No set has refused a member, so the bucket holds no flags and there is no
    // earlier value to keep.
    const unflagged = await rowsOf(place);
    expect(unflagged.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', overflow: false }),
      expect.objectContaining({ grain: 'day', overflow: false }),
    ]);

    await viewBeacon(place, arriving(place), place.landingPath, SET_FULL_AT_TWO);

    const after = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(after.isOk()).toBe(true);
    const raised = await rowsOf(place);
    expect(raised.visitors).toEqual([
      expect.objectContaining({ grain: 'hour', overflow: true }),
      expect.objectContaining({ grain: 'day', overflow: true }),
    ]);
  });

  // The whole run is one transaction, so a refusal at any write leaves the hour
  // exactly as it was — there is no partial hour for a redrive to reconcile.
  it('leaves no row behind when one of its writes is refused', async () => {
    const place = await scene(9, 4);
    await seedBeacons(place);
    // The campaign row the counted tags reference, removed after the beacons
    // landed: the campaign-path write then violates its foreign key, which is a
    // refusal arriving after several tables have already been written to.
    await db.delete(campaigns).where(eq(campaigns.tag, place.campaign));
    const untouched = await rowsOf(place);

    const rolled = await rollupGrowthHour({
      db,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await rowsOf(place)).toEqual(nothingWritten(untouched));
  });

  it('reports the database’s own failure when the campaign list cannot be read', async () => {
    const place = await scene(10, 6);
    const closed = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closed.$client.end();

    const rolled = await rollupGrowthHour({
      db: closed,
      redis,
      hour: place.hour,
      now: new Date(place.at.getTime() + HOUR_MS),
    });
    expect(rolled._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('writes nothing and succeeds for an hour with no keys still inside the window', async () => {
    const place = await scene(4, 12);
    const now = new Date(place.at.getTime() + HOUR_MS);
    const untouched = await rowsOf(place);

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now });
    expect(rolled._unsafeUnwrap()).toEqual({ kind: 'silent' });
    expect(await rowsOf(place)).toEqual(nothingWritten(untouched));
  });

  it('reports an hour with no keys past the window as lost', async () => {
    const place = await scene(5, 12);
    const past = new Date(
      place.hourAt.getTime() + (GROWTH_REDIS_TTL_SECONDS - GROWTH_ROLLUP_MARGIN_SECONDS) * 1000
    );

    const rolled = await rollupGrowthHour({ db, redis, hour: place.hour, now: past });
    expect(rolled._unsafeUnwrap()).toEqual({ kind: 'lost' });
  });

  it('answers the job with an empty row count for a silent hour', async () => {
    const place = await scene(11, 12);
    const outcome = await registrationFor(() => new Date(place.at.getTime() + HOUR_MS)).handler(
      executionFor(place.hour)
    );
    expect(outcome).toEqual({
      kind: 'ok',
      result: {
        hour: place.hour,
        rows: {
          visitors: 0,
          paths: 0,
          referrers: 0,
          campaignPaths: 0,
          geo: 0,
          events: 0,
          productEntry: 0,
          reach: 0,
          funnel: 0,
        },
      },
    });
  });

  it('fails the job under the registered code when the hour is lost', async () => {
    const place = await scene(6, 12);
    const past = new Date(
      place.hourAt.getTime() + (GROWTH_REDIS_TTL_SECONDS - GROWTH_ROLLUP_MARGIN_SECONDS) * 1000
    );

    const outcome = await registrationFor(() => past).handler(executionFor(place.hour));
    expect(outcome).toEqual({ kind: 'fail', error: GROWTH_ROLLUP_HOUR_LOST });
  });

  it('fails the job under the dependency’s own code when the counter is unreachable', async () => {
    const place = await scene(7, 12);
    const outcome = await createGrowthRollupJobRegistration({
      db,
      resolveRedis: () => unreachableRedis,
      resolveTelemetry: () => recordingTelemetry().telemetry,
      now: () => new Date(place.at.getTime() + HOUR_MS),
    }).handler(executionFor(place.hour));
    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
  });
});

describe('the growth rollup job registration', () => {
  it('declares the versioned type, the natural class and its payload contract', () => {
    const registration = registrationFor(() => new Date(TEST_DAY_START));
    expect(registration.type).toBe(GROWTH_ROLLUP_JOB_TYPE);
    expect(registration.idempotency).toBe('natural');
    expect(registration.maxExecutionSeconds).toBe(120);
    expect(registration.schema.safeParse({ hour: '2026-01-15T09' }).success).toBe(true);
  });

  it('refuses a payload hour no clock can produce', () => {
    const registration = registrationFor(() => new Date(TEST_DAY_START));
    expect(registration.schema.safeParse({ hour: '2026-02-30T09' }).success).toBe(false);
    expect(registration.schema.safeParse({ hour: '2026-01-15T24' }).success).toBe(false);
    expect(registration.schema.safeParse({ hour: '2026-01-15' }).success).toBe(false);
  });

  /**
   * A stored landing count above the visitors a re-roll read can only mean the
   * counting store lost members, and clamping it without saying so would erase
   * the one signal that loss leaves. The scheduled run's channel for it is the
   * retained one.
   */
  async function lostMembersOn(dayIndex: number): Promise<Scene> {
    const place = await scene(dayIndex, 8);
    const visitor = arriving(place);
    trackSceneKeys(place, [visitor]);
    await viewBeacon(place, visitor, place.landingPath, GROWTH_CEILINGS);
    await expireDayLandings(place, place.landingPath);
    await db.insert(growthPaths).values({
      grain: 'day',
      bucket: place.dayAt,
      path: place.landingPath,
      visitors: 12,
      landings: 2,
    });
    return place;
  }

  it('captures a lowered landing count under the registered code', async () => {
    const place = await lostMembersOn(15);
    const recorder = recordingTelemetry();

    await registrationFor(() => new Date(place.at.getTime() + HOUR_MS), recorder.telemetry).handler(
      executionFor(place.hour)
    );

    expect(recorder.captures.map((capture) => capture.code)).toEqual([
      'growth_landing_count_clamped',
    ]);
  });

  it('carries the lowered row’s grain, bucket and path on the captured error, and nothing else', async () => {
    const place = await lostMembersOn(26);
    const recorder = recordingTelemetry();

    await registrationFor(() => new Date(place.at.getTime() + HOUR_MS), recorder.telemetry).handler(
      executionFor(place.hour)
    );

    const error = recorder.captures[0]?.error as object;
    // The whole key set, not a lookup of the three expected: two of the scrub's
    // gates for these names are shape checks rather than enumerations, so what
    // they rest on is the producer emitting those values and nothing beside
    // them.
    expect(Object.keys(error)).toEqual([
      'growthClampedGrain',
      'growthClampedBucket',
      'growthClampedPath',
    ]);
    expect(Reflect.get(error, 'growthClampedGrain')).toBe('day');
    expect(Reflect.get(error, 'growthClampedBucket')).toBe(place.day);
    expect(Reflect.get(error, 'growthClampedPath')).toBe(place.landingPath);
  });

  it('captures nothing when the re-roll lowered no landing count', async () => {
    const place = await scene(27, 8);
    await seedBeacons(place);
    const recorder = recordingTelemetry();

    await registrationFor(() => new Date(place.at.getTime() + HOUR_MS), recorder.telemetry).handler(
      executionFor(place.hour)
    );

    expect(recorder.captures).toEqual([]);
  });
});

describe('growthRollupWindow', () => {
  it('reaches back over every hour whose keys the retention window still holds', () => {
    const now = new Date(TEST_DAY_START + 3 * DAY_MS + 30 * 60 * 1000);
    const window = growthRollupWindow(now);
    expect(window).toHaveLength(GROWTH_ROLLUP_WINDOW_HOURS);
    expect(window.at(-1)).toBe(growthHourBucket(new Date(now.getTime() - HOUR_MS)));
    expect(window[0]).toBe(
      growthHourBucket(new Date(now.getTime() - GROWTH_ROLLUP_WINDOW_HOURS * HOUR_MS))
    );
  });

  it('holds every hour it names inside the window the rollup calls live', () => {
    const now = new Date(TEST_DAY_START + 3 * DAY_MS + 59 * 60 * 1000);
    const live = (GROWTH_REDIS_TTL_SECONDS - GROWTH_ROLLUP_MARGIN_SECONDS) * 1000;
    for (const hour of growthRollupWindow(now)) {
      expect(now.getTime() - new Date(`${hour}:00:00.000Z`).getTime()).toBeLessThan(live);
    }
  });
});

describe('createGrowthRollupEnqueueEntry', () => {
  it('enqueues one deduped job per hour of the trailing window', async () => {
    const collector = createJobWakeCollector();
    const wakeful = grantJobWakes(db, collector);
    const now = dayApart(8);
    const registry = createAppJobRegistry([registrationFor(() => now)]);
    const hours = growthRollupWindow(now);
    for (const hour of hours) enqueuedDedupeKeys.push(`${GROWTH_ROLLUP_JOB_TYPE}:${hour}`);

    const entry = createGrowthRollupEnqueueEntry({
      db: wakeful,
      resolveRegistry: () => registry,
      now: () => now,
    });
    await entry.run();

    const rows = await db
      .select({ dedupeKey: jobs.dedupeKey, type: jobs.type })
      .from(jobs)
      .where(inArray(jobs.dedupeKey, enqueuedDedupeKeys));
    expect(rows).toHaveLength(hours.length);
    expect(rows.every((row) => row.type === GROWTH_ROLLUP_JOB_TYPE)).toBe(true);
    expect(jobWakesOf(wakeful)?.shards()).toEqual(['bulk']);

    // A second tick inside the same hour adds nothing: the per-hour dedupe key
    // covers a duplicate invocation while a row is still pending.
    await entry.run();
    const again = await db
      .select({ dedupeKey: jobs.dedupeKey })
      .from(jobs)
      .where(inArray(jobs.dedupeKey, enqueuedDedupeKeys));
    expect(again).toHaveLength(hours.length);
  });
});
