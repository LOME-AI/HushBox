import { z } from 'zod';
import {
  campaigns,
  growthCampaignPaths,
  growthDailyPathReach,
  growthGeo,
  growthHourlyEvents,
  growthHourlyFunnel,
  growthHourlyProductEntry,
  growthPaths,
  growthReferrers,
  growthVisitors,
  landingsAboveVisitors,
} from '@hushbox/db';
import { GrowthDevice } from '@hushbox/shared';
import { HOUR_MS, SECOND_MS } from '@hushbox/shared/durations';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  decodeGrowthIndexMember,
  growthHourBucket,
  redisHGetAll,
  redisScard,
  redisSmembers,
} from '../../../lib/redis/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { ResultAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import {
  enqueueWithinTx,
  grantJobWakes,
  jobOutcome,
  runWithJobWakes,
} from '../../../lib/jobs/index.js';
import type { Database } from '@hushbox/db';
import type { GrowthGrain } from '@hushbox/shared';
import type { GrowthGrainKey, GrowthIndexFamily } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { Variables } from '../../../lib/context/index.js';
import type {
  CronEntry,
  JobOutcome,
  JobRegistry,
  JobWakeCapable,
  OneShotJobRegistration,
} from '../../../lib/jobs/index.js';

/**
 * The hourly reduction of the counting store into the growth tables.
 *
 * Three properties carry it. Every write is an ASSIGNMENT on the row's own
 * dimension tuple, never an increment, which is what makes a redriven job
 * converge instead of doubling. The whole run commits in ONE transaction, so a
 * crash mid-run leaves no half-written hour for a redrive to reconcile. And
 * families are enumerated from the index sets rather than by scanning the key
 * space, with each member decoded through the same shared pair of functions the
 * beacon encoded it with — a hand-rolled split would tear an event name such as
 * `link:/signup` in half and file its count under a dimension nobody wrote,
 * which is a wrong number rather than an error.
 *
 * Nothing is deleted here: the counting store's own lifetime is the only prune,
 * and that is what makes the age of a keyless hour meaningful. An hour with no
 * keys inside that lifetime is a legitimately silent hour; one past it was
 * never rolled and its counts are gone, so it fails loudly and becomes a dead
 * row a human redrives.
 *
 * WHAT MAY BE WRITTEN. Every value read out of the counting store and written
 * into a table is backed by its own evidence that the store still holds it, or
 * it is not written and the column keeps what an earlier run put there. A store
 * that no longer holds a key answers zero and false, which is not the fact that
 * nobody came and the set never filled; these tables are kept forever and
 * nothing rewrites a row, so a guess assigned once stands for good. A lifetime
 * is extended per KEY, by the writes naming that key, so evidence and value
 * have to be checked as the separate keys they are — a key that outlives
 * another vouches for nothing about it.
 *
 * Two shapes of evidence exist, and every reading either has one or is not
 * written:
 *
 * A SET'S OWN CARDINALITY vouches for itself. A set exists only while it holds
 * a member, so a non-zero answer is the store saying it still holds that set,
 * and there is no window in which the evidence dies before the value it stands
 * for. Nothing in this slice removes a member, so a set only grows until it
 * expires whole and a cardinality of zero is the set's absence rather than an
 * emptied set — the evidence and the value stay one fact only while that
 * holds, and a removal anywhere here would turn every count backed by its own
 * cardinality into the guess this property exists to keep out of these tables.
 * This backs every count written here, and every reader of such a count drops
 * a reading of zero rather than writing it: {@link visitorsRows} for the
 * bucket's own visitors, {@link productEntryRows} for the entrants among them,
 * {@link indexedRows} for every family an index set enumerates,
 * {@link funnelRows} for the registration starts.
 *
 * THE BUCKET'S OVERFLOW HASH vouches for every field in it. Fields are latched
 * and never removed, the hash expires whole, and a bucket's refusals all fall
 * inside the bucket's own span — an hour or a day, both shorter than the key
 * lifetime — so a hash answering with any field carries every refusal that
 * bucket saw, and a field missing from it is evidence the set was never
 * refused. An empty answer carries no evidence either way — it is equally the
 * bucket where nothing filled and the bucket whose flags expired out from under
 * sets that are still live, and only one of those answers is false.
 * {@link overflowOf} reports that case as unknown.
 *
 * The reading with NEITHER is the landing count. Its set is keyed apart from
 * the view set naming the same row, and the two are extended by different
 * writes: every view extends the view set, while only a new visitor's first
 * sight of the day extends the landing set. So the landing set dies first, and
 * in the window between the two deaths its zero cannot be told from a page
 * nobody started on. It is written when it is non-zero and left alone
 * otherwise; a page that genuinely had none keeps the zero its own insert put
 * there.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

export const GROWTH_ROLLUP_JOB_TYPE = 'growth.rollup.v1';

/**
 * The code a never-rolled hour fails under. Registered as a constant rather
 * than written at the return, because it is what an operator greps for in the
 * dead row's error history — the one place this failure is recorded.
 */
export const GROWTH_ROLLUP_HOUR_LOST = 'growth_rollup_hour_lost';

/**
 * How much of the counting store's retention must remain for a keyless hour to
 * read as silent rather than lost. One scheduled cadence: an hour the last tick
 * inside the window could still have rolled is never called lost.
 */
export const GROWTH_ROLLUP_MARGIN_SECONDS = 60 * 60;

/** The retention a rolled hour's keys are still guaranteed to be inside. */
const LIVE_WINDOW_MS = (GROWTH_REDIS_TTL_SECONDS - GROWTH_ROLLUP_MARGIN_SECONDS) * SECOND_MS;

/**
 * How many hours back the enqueue reaches. Derived rather than written: the
 * newest instant inside the enqueuing hour is very nearly a whole hour past its
 * start, so the oldest hour named has to stay live for one hour longer than its
 * own offset — hence the hour subtracted from the live window's span.
 */
export const GROWTH_ROLLUP_WINDOW_HOURS = Math.floor(LIVE_WINDOW_MS / HOUR_MS) - 1;

/** Retries a transient database or counter outage; a permanent one dead-letters and pages. */
const GROWTH_ROLLUP_MAX_FAILURES = 5;

/** Far inside the dispatcher's pass budget: one hour's reduction is a bounded set of round trips. */
const GROWTH_ROLLUP_MAX_EXECUTION_SECONDS = 120;

/**
 * The hour is the unit of work, not the fire time: a retry that crosses an hour
 * boundary must still reduce the hour it was enqueued for. A shape-valid but
 * non-existent hour (`2026-02-30T09`, `2026-01-15T24`) rolls over rather than
 * failing to parse, so the round trip is what catches it — refused at enqueue,
 * inside the caller's transaction, rather than becoming a row that can never
 * succeed.
 */
export const growthRollupHourSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
  .refine((hour) => growthHourBucket(new Date(`${hour}:00:00.000Z`)) === hour);

const growthRollupPayloadSchema = z.object({ hour: growthRollupHourSchema });

/** The pgEnum spelling of a grain, keyed by the spelling its Redis keys carry. */
const GRAIN_NAME = { h: 'hour', d: 'day' } as const satisfies Record<GrowthGrainKey, GrowthGrain>;

/** The bucket's overflow hash: one field per set that refused a member at its ceiling. */
type OverflowFlags = Readonly<Record<string, 1>>;

/**
 * Whether the bucket's overflow hash is still there. Read as emptiness because
 * a Redis hash exists exactly while it holds a field, so the empty answer the
 * client synthesises for a missing key is the only absent case there is.
 */
function holdsFlags(flags: OverflowFlags): boolean {
  return Object.keys(flags).length > 0;
}

/**
 * Whether any of the sets filling one row filled, or `undefined` when the
 * bucket holds no flags at all and the store no longer knows. The module
 * docblock argues why an answering hash vouches for a field it does not carry
 * and an empty one vouches for nothing.
 *
 * Several fields because a row fed by more than one set is a floor when any of
 * them refused a member, and one hash answers for all of them — so they are
 * known together or unknown together, never mixed.
 */
function overflowOf(read: GrainRead, ...fields: readonly string[]): boolean | undefined {
  return read.flagsKnown ? fields.some((field) => read.flags[field] === 1) : undefined;
}

/** The two buckets one rolled hour writes into: its own hour, and the UTC day holding it. */
interface RollupBuckets {
  readonly hour: string;
  readonly day: string;
  readonly hourAt: Date;
  readonly dayAt: Date;
}

/** One grain of one bucket, with everything a family read needs to name its sets. */
interface GrainRead {
  readonly redis: RedisClient;
  readonly grain: GrowthGrainKey;
  readonly bucket: string;
  readonly at: Date;
  readonly flags: OverflowFlags;
  /** Whether the bucket's hash is still there to vouch for the fields it carries. */
  readonly flagsKnown: boolean;
}

interface VisitorsRow {
  readonly grain: GrowthGrain;
  readonly bucket: Date;
  readonly visitors: number;
  /** Absent where the store no longer vouches for it, which writes no `overflow`. */
  readonly overflow: boolean | undefined;
}

interface PathRow extends VisitorsRow {
  readonly path: string;
  /** Absent where the store no longer vouches for it, which writes no `landings`. */
  readonly landings: number | undefined;
}

interface ReferrerRow extends VisitorsRow {
  readonly path: string;
  readonly referrerHost: string;
}

interface CampaignPathRow extends VisitorsRow {
  readonly campaign: string;
  readonly path: string;
}

interface GeoRow extends VisitorsRow {
  readonly country: string;
  readonly region: string;
  readonly device: GrowthDevice;
}

/**
 * Who entered the product in the hour, under no campaign — the marginal the
 * campaign-keyed {@link EventRow}s cannot be added up into.
 */
interface ProductEntryRow {
  readonly hour: Date;
  readonly visitors: number;
  /** Absent where the store no longer vouches for it, which writes no `overflow`. */
  readonly overflow: boolean | undefined;
}

interface EventRow {
  readonly hour: Date;
  readonly campaign: string;
  readonly eventName: string;
  readonly path: string;
  readonly visitors: number;
  /** Absent where the store no longer vouches for it, which writes no `overflow`. */
  readonly overflow: boolean | undefined;
}

/** A same-day journey, counted from a day-grain beacon set with its own flag field. */
interface ReachRow {
  readonly day: string;
  readonly landingPath: string;
  readonly reachedPath: string;
  readonly visitors: number;
  /** Absent where the store no longer vouches for it, which writes no `overflow`. */
  readonly overflow: boolean | undefined;
}

/**
 * Registration starts. Its count is the cardinality of a ceiling-bounded set,
 * so it carries the flag on the terms the rows around it carry theirs: the
 * set's own name on the hour bucket's overflow hash, latched where the ceiling
 * refused an address.
 */
interface FunnelRow {
  readonly hour: Date;
  readonly campaign: string;
  readonly step: 'started';
  readonly registrations: number;
  /** Absent where the store no longer vouches for it, which writes no `overflow`. */
  readonly overflow: boolean | undefined;
}

/** Everything one hour bucket produced. */
interface HourReading {
  readonly visitors: readonly VisitorsRow[];
  readonly paths: readonly PathRow[];
  readonly referrers: readonly ReferrerRow[];
  readonly campaignPaths: readonly CampaignPathRow[];
  readonly geo: readonly GeoRow[];
  readonly events: readonly EventRow[];
  readonly productEntry: readonly ProductEntryRow[];
  readonly funnel: readonly FunnelRow[];
}

/** Everything the rolled hour's UTC day produced, read from the day sets. */
interface DayReading {
  readonly visitors: readonly VisitorsRow[];
  readonly paths: readonly PathRow[];
  readonly referrers: readonly ReferrerRow[];
  readonly campaignPaths: readonly CampaignPathRow[];
  readonly geo: readonly GeoRow[];
  readonly reach: readonly ReachRow[];
}

export interface GrowthRollupInput {
  readonly db: Database;
  readonly redis: RedisClient;
  /** The UTC hour bucket to reduce, `YYYY-MM-DDTHH`. */
  readonly hour: string;
  readonly now: Date;
}

/** How many rows each table took, so a run says what it did without naming a dimension. */
export interface GrowthRollupRowCounts {
  readonly visitors: number;
  readonly paths: number;
  readonly referrers: number;
  readonly campaignPaths: number;
  readonly geo: number;
  readonly events: number;
  readonly productEntry: number;
  readonly reach: number;
  readonly funnel: number;
}

/**
 * One path row whose stored landing count a re-roll had to bring back inside
 * the visitor count it was writing, named as an operator would address the row.
 */
export interface GrowthLandingClamp {
  readonly grain: GrowthGrain;
  /** The bucket's own key: `YYYY-MM-DDTHH` at hour grain, `YYYY-MM-DD` at day grain. */
  readonly bucket: string;
  readonly path: string;
}

export type GrowthRollupOutcome =
  | {
      readonly kind: 'rolled';
      readonly rows: GrowthRollupRowCounts;
      /**
       * Empty is the ordinary case. An entry says the counting sets lost
       * members the row outlived, which is a fact each caller reports on the
       * channel it has rather than one the reduction reports for them.
       */
      readonly clamped: readonly GrowthLandingClamp[];
    }
  /** No keys, and the window that would have held them has not run out. */
  | { readonly kind: 'silent' }
  /** No keys, and the window ran out: this hour was never rolled and its counts are gone. */
  | { readonly kind: 'lost' };

const NO_ROWS: GrowthRollupRowCounts = {
  visitors: 0,
  paths: 0,
  referrers: 0,
  campaignPaths: 0,
  geo: 0,
  events: 0,
  productEntry: 0,
  reach: 0,
  funnel: 0,
};

function bucketsFor(hour: string): RollupBuckets {
  const day = new Date(`${hour}:00:00.000Z`);
  const dayKey = hour.slice(0, hour.indexOf('T'));
  return {
    hour,
    day: dayKey,
    hourAt: day,
    // The rolled hour's own day, never the day the job runs in: the run for
    // hour 23 fires after midnight, and its day rows belong to the day that
    // ended, not the one that started.
    dayAt: new Date(`${dayKey}T00:00:00.000Z`),
  };
}

/**
 * One row per distinct dimension value the family opened in the bucket, minus
 * every value the counting store no longer holds a set for.
 *
 * The index set is the enumeration, never a scan of the key space: a scan would
 * have to parse dimensions back out of key names, and every delimiter a key
 * template could use appears inside a legal path, host or event name.
 *
 * The index outlives its members. Every write to the family extends the index,
 * while one value's set is extended only by writes naming that value, so a page
 * or a referrer that stops receiving traffic before the family does is still
 * named by the index with nothing behind it. Its cardinality then reads zero,
 * and that zero means the store no longer knows rather than that nobody came —
 * a distinction these tables have to keep, because retention is forever, an
 * assignment would write the guess over a row an earlier run got right, and
 * nothing rewrites it afterwards. So a reading with no set behind it writes no
 * row, which is the same treatment {@link funnelRows} gives a campaign with no
 * starts.
 */
function indexedRows<Row extends { readonly visitors: number }>(
  read: GrainRead,
  family: GrowthIndexFamily,
  row: (member: string) => ResultAsync<Row, DomainError>
): ResultAsync<readonly Row[], DomainError> {
  return redisSmembers(read.redis, GROWTH_REDIS_KEYS.index, read.grain, read.bucket, family)
    .andThen((members) => ResultAsync.combine(members.map((member) => row(member))))
    .map((rows) => rows.filter((candidate) => candidate.visitors > 0));
}

/** The bucket's own visitor row, or none at all when the store holds no set for it. */
function visitorsRows(read: GrainRead): ResultAsync<readonly VisitorsRow[], DomainError> {
  return redisScard(read.redis, GROWTH_REDIS_KEYS.visitors, read.grain, read.bucket).map(
    (visitors) =>
      visitors === 0
        ? []
        : [
            {
              grain: GRAIN_NAME[read.grain],
              bucket: read.at,
              visitors,
              overflow: overflowOf(read, GROWTH_REDIS_KEYS.visitors.setName()),
            },
          ]
  );
}

function pathRows(read: GrainRead): ResultAsync<readonly PathRow[], DomainError> {
  // Two sets fill this row and only one of them backs it. The view set is the
  // row's existence evidence and vouches for itself. The landing set is a
  // separate key with a separate lifetime, extended only by a new visitor's
  // first sight of the day where the view set is extended by every view, so it
  // is the one that dies first and its zero is not readable as a page nobody
  // started on.
  return indexedRows(read, 'paths', (member) => {
    const [path] = decodeGrowthIndexMember(member, 1);
    return redisScard(read.redis, GROWTH_REDIS_KEYS.views, read.grain, read.bucket, path).andThen(
      (visitors) =>
        redisScard(read.redis, GROWTH_REDIS_KEYS.landings, read.grain, read.bucket, path).map(
          (landings) => ({
            grain: GRAIN_NAME[read.grain],
            bucket: read.at,
            path,
            visitors,
            landings: landings === 0 ? undefined : landings,
            overflow: overflowOf(
              read,
              GROWTH_REDIS_KEYS.views.setName(path),
              GROWTH_REDIS_KEYS.landings.setName(path)
            ),
          })
        )
    );
  });
}

function referrerRows(read: GrainRead): ResultAsync<readonly ReferrerRow[], DomainError> {
  return indexedRows(read, 'referrers', (member) => {
    const [path, referrerHost] = decodeGrowthIndexMember(member, 2);
    return redisScard(
      read.redis,
      GROWTH_REDIS_KEYS.referrers,
      read.grain,
      read.bucket,
      path,
      referrerHost
    ).map((visitors) => ({
      grain: GRAIN_NAME[read.grain],
      bucket: read.at,
      path,
      referrerHost,
      visitors,
      overflow: overflowOf(read, GROWTH_REDIS_KEYS.referrers.setName(path, referrerHost)),
    }));
  });
}

function campaignPathRows(read: GrainRead): ResultAsync<readonly CampaignPathRow[], DomainError> {
  return indexedRows(read, 'campaigns', (member) => {
    const [campaign, path] = decodeGrowthIndexMember(member, 2);
    return redisScard(
      read.redis,
      GROWTH_REDIS_KEYS.campaignPaths,
      read.grain,
      read.bucket,
      campaign,
      path
    ).map((visitors) => ({
      grain: GRAIN_NAME[read.grain],
      bucket: read.at,
      campaign,
      path,
      visitors,
      overflow: overflowOf(read, GROWTH_REDIS_KEYS.campaignPaths.setName(campaign, path)),
    }));
  });
}

function geoRows(read: GrainRead): ResultAsync<readonly GeoRow[], DomainError> {
  return indexedRows(read, 'geo', (member) => {
    const [country, region, family] = decodeGrowthIndexMember(member, 3);
    // The one place a counted dimension re-enters a closed set. Parsed rather
    // than asserted: the value came back from a store, and a device family
    // outside the enum is a defect the pgEnum would refuse anyway.
    const place = { country, region, device: GrowthDevice.parse(family) };
    return redisScard(read.redis, GROWTH_REDIS_KEYS.geo, read.grain, read.bucket, place).map(
      (visitors) => ({
        grain: GRAIN_NAME[read.grain],
        bucket: read.at,
        ...place,
        visitors,
        overflow: overflowOf(read, GROWTH_REDIS_KEYS.geo.setName(place)),
      })
    );
  });
}

function eventRows(read: GrainRead, hourAt: Date): ResultAsync<readonly EventRow[], DomainError> {
  return indexedRows(read, 'events', (member) => {
    const [campaign, eventName, path] = decodeGrowthIndexMember(member, 3);
    return redisScard(
      read.redis,
      GROWTH_REDIS_KEYS.events,
      read.bucket,
      campaign,
      eventName,
      path
    ).map((visitors) => ({
      hour: hourAt,
      campaign,
      eventName,
      path,
      visitors,
      overflow: overflowOf(read, GROWTH_REDIS_KEYS.events.setName(campaign, eventName, path)),
    }));
  });
}

/** The hour's own entry-click row, or none at all when the store holds no set for it. */
function productEntryRows(
  read: GrainRead,
  hourAt: Date
): ResultAsync<readonly ProductEntryRow[], DomainError> {
  return redisScard(read.redis, GROWTH_REDIS_KEYS.productEntry, read.bucket).map((visitors) =>
    visitors === 0
      ? []
      : [
          {
            hour: hourAt,
            visitors,
            overflow: overflowOf(read, GROWTH_REDIS_KEYS.productEntry.setName()),
          },
        ]
  );
}

function reachRows(read: GrainRead): ResultAsync<readonly ReachRow[], DomainError> {
  return indexedRows(read, 'reach', (member) => {
    const [landingPath, reachedPath] = decodeGrowthIndexMember(member, 2);
    return redisScard(
      read.redis,
      GROWTH_REDIS_KEYS.reach,
      read.bucket,
      landingPath,
      reachedPath
    ).map((visitors) => ({
      day: read.bucket,
      landingPath,
      reachedPath,
      visitors,
      overflow: overflowOf(read, GROWTH_REDIS_KEYS.reach.setName(landingPath, reachedPath)),
    }));
  });
}

/**
 * Registration starts per campaign, read from the counted set and never from
 * the shadow set beside it — that one exists so the existing-email branch costs
 * the same as the real one, and counting it would report an enumeration probe
 * as a signup attempt.
 *
 * The campaigns are enumerated from the table rather than from an index set,
 * because this family has none: a tag exists because an operator minted it, and
 * that bounds the family more tightly than a number would. A tag existing is
 * therefore no evidence a set does, so a campaign with no starts in the hour
 * gets no row.
 */
function funnelRows(
  read: GrainRead,
  buckets: RollupBuckets,
  tags: readonly string[]
): ResultAsync<readonly FunnelRow[], DomainError> {
  return ResultAsync.combine(
    tags.map((campaign) =>
      redisScard(read.redis, GROWTH_REDIS_KEYS.started, buckets.hour, campaign).map(
        (registrations) => ({
          hour: buckets.hourAt,
          campaign,
          step: 'started' as const,
          registrations,
          overflow: overflowOf(read, GROWTH_REDIS_KEYS.started.setName(campaign)),
        })
      )
    )
  ).map((rows) => rows.filter((row) => row.registrations > 0));
}

/**
 * Every campaign tag, archived ones included: a start counted under a tag
 * archived since is still a real start, and a campaign row is never deleted, so
 * the funnel row's foreign key always resolves.
 */
function readCampaignTags(db: Database): ResultAsync<readonly string[], DomainError> {
  return fromPromise(db.select({ tag: campaigns.tag }).from(campaigns), (cause) =>
    unavailableError('growth rollup campaign read failed', cause)
  ).map((rows) => rows.map((row) => row.tag));
}

function readHour(
  redis: RedisClient,
  buckets: RollupBuckets,
  tags: readonly string[]
): ResultAsync<HourReading, DomainError> {
  return redisHGetAll(redis, GROWTH_REDIS_KEYS.overflow, 'h', buckets.hour).andThen((flags) => {
    const read: GrainRead = {
      redis,
      grain: 'h',
      bucket: buckets.hour,
      at: buckets.hourAt,
      flags,
      flagsKnown: holdsFlags(flags),
    };
    return ResultAsync.combine([
      visitorsRows(read),
      pathRows(read),
      referrerRows(read),
      campaignPathRows(read),
      geoRows(read),
      eventRows(read, buckets.hourAt),
      productEntryRows(read, buckets.hourAt),
      funnelRows(read, buckets, tags),
    ] as const).map(
      ([visitors, paths, referrers, campaignPaths, geo, events, productEntry, funnel]) => ({
        visitors,
        paths,
        referrers,
        campaignPaths,
        geo,
        events,
        productEntry,
        funnel,
      })
    );
  });
}

function readDay(redis: RedisClient, buckets: RollupBuckets): ResultAsync<DayReading, DomainError> {
  return redisHGetAll(redis, GROWTH_REDIS_KEYS.overflow, 'd', buckets.day).andThen((flags) => {
    const read: GrainRead = {
      redis,
      grain: 'd',
      bucket: buckets.day,
      at: buckets.dayAt,
      flags,
      flagsKnown: holdsFlags(flags),
    };
    return ResultAsync.combine([
      visitorsRows(read),
      pathRows(read),
      referrerRows(read),
      campaignPathRows(read),
      geoRows(read),
      reachRows(read),
    ] as const).map(([visitors, paths, referrers, campaignPaths, geo, reach]) => ({
      visitors,
      paths,
      referrers,
      campaignPaths,
      geo,
      reach,
    }));
  });
}

/**
 * Whether the hour opened no key at all. Read over the hour's own keys: a day
 * bucket outlives every hour in it, so a busy day says nothing about whether
 * this hour was written, and the hour that WAS written rolls the day rows.
 */
function openedNoKey(hour: HourReading): boolean {
  return (
    hour.visitors.length === 0 &&
    hour.paths.length === 0 &&
    hour.referrers.length === 0 &&
    hour.campaignPaths.length === 0 &&
    hour.geo.length === 0 &&
    hour.events.length === 0 &&
    // The entry set is not asked after: its members are a subset of the same
    // hour's visitor set, and every beacon that adds to it adds there too, so
    // the visitor line above already answers for it.
    hour.funnel.length === 0
  );
}

/** Whether the counting store can no longer be holding this hour's keys. */
function pastTheWindow(buckets: RollupBuckets, now: Date): boolean {
  return now.getTime() - buckets.hourAt.getTime() >= LIVE_WINDOW_MS;
}

/** The `overflow` assignment while the bucket still vouches for it, and nothing otherwise. */
function assignOverflow(overflow: boolean | undefined): { overflow?: boolean } {
  return overflow === undefined ? {} : { overflow };
}

/** The `landings` assignment while its own set still vouches for it, and nothing otherwise. */
function assignLandings(landings: number | undefined): { landings?: number } {
  return landings === undefined ? {} : { landings };
}

/** A row's INSERT values and the assignment its conflict takes, decided together. */
interface CountedWrite<Values, Assignment> {
  readonly values: Values;
  readonly set: Assignment;
}

/** The two halves of one counted row, for every table whose counts are a visitor tally. */
function counted<Row extends { readonly visitors: number; readonly overflow: boolean | undefined }>(
  row: Row
): CountedWrite<Row & { overflow: boolean }, { visitors: number; overflow?: boolean }> {
  return {
    values: { ...row, overflow: row.overflow ?? false },
    set: { visitors: row.visitors, ...assignOverflow(row.overflow) },
  };
}

/** The same two halves for the path row, whose second count comes from a set of its own. */
function countedPath(
  row: PathRow
): CountedWrite<
  PathRow & { landings: number; overflow: boolean },
  { visitors: number; landings?: number; overflow?: boolean }
> {
  return {
    values: { ...row, landings: row.landings ?? 0, overflow: row.overflow ?? false },
    set: {
      visitors: row.visitors,
      ...assignLandings(row.landings),
      ...assignOverflow(row.overflow),
    },
  };
}

/** The same two halves for the funnel row, whose count tallies addresses rather than visitors. */
function countedStart(
  row: FunnelRow
): CountedWrite<FunnelRow & { overflow: boolean }, { registrations: number; overflow?: boolean }> {
  return {
    values: { ...row, overflow: row.overflow ?? false },
    set: { registrations: row.registrations, ...assignOverflow(row.overflow) },
  };
}

/** The transaction handle the write runs on, derived from the client rather than restated. */
type RollupTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The stored landing count brought back inside the visitors about to be
 * written, where the store no longer vouches for the landings — and the row it
 * lowered, for the caller to report.
 *
 * Only where the reading carries no landings: a reading that carries a count
 * assigns that count, which is a fresh observation rather than a stale one, and
 * the ceiling that applies to it is its own set's.
 *
 * A stored count above the count being written can only mean the counting sets
 * lost members the rows outlived, and the lower of the two is the only value
 * both the table's check and the evidence allow: a landing count was never
 * observed above its own visitor count while both sets were whole, so what
 * stands above the new reading is stale rather than true.
 *
 * One conditional UPDATE rather than a read followed by a write: two rollups of
 * different hours of the same day address the same day row, so a count read
 * before the row was locked can be stale by the time the update applies.
 */
async function clampFor(
  tx: RollupTx,
  buckets: RollupBuckets,
  row: PathRow
): Promise<readonly GrowthLandingClamp[]> {
  if (row.landings !== undefined) return [];
  const lowered = await tx
    .update(growthPaths)
    .set({ landings: row.visitors })
    .where(
      landingsAboveVisitors({
        grain: row.grain,
        bucket: row.bucket,
        path: row.path,
        visitors: row.visitors,
      })
    )
    .returning({ path: growthPaths.path });
  return lowered.length > 0
    ? [
        {
          grain: row.grain,
          bucket: row.grain === 'hour' ? buckets.hour : buckets.day,
          path: row.path,
        },
      ]
    : [];
}

/**
 * Every row of both grains, assigned on its own dimension tuple inside ONE
 * transaction.
 *
 * Assignment is what makes the job convergent: `DO UPDATE SET` writes the
 * cardinality the sets hold now, so two runs inside the retention window leave
 * the same rows and a redrive is free. The single transaction is what makes a
 * crash free too — a run killed part way through leaves no partial hour behind
 * for the next one to reconcile against.
 *
 * Every count it writes was read before the transaction opened. Nothing here
 * reaches the counting store, because a store write is not covered by a
 * rollback and a store READ inside a transaction makes the transaction's
 * duration a network round trip.
 *
 * Which columns each row may assign is decided out here too, by
 * {@link counted}, {@link countedPath} and {@link countedStart}, for the same
 * reason and one more: a column the store no longer vouches for is simply left
 * out of the assignment, since `DO UPDATE SET` touches only the columns it
 * names and omitting one is how the row keeps what an earlier run wrote there.
 * The INSERT beside it names every column — it has no earlier row to keep
 * anything from, and the columns are `NOT NULL`, so a row written for the
 * first time starts at what a row with no such reading already means.
 *
 * The one column that cannot simply be left out is the landing count: a stored
 * count above the visitor count being written is a row the table's own check
 * refuses, so where the store no longer vouches for the landings the stored
 * count is clamped to what is being written before the row is assigned. The
 * clamp holds the row's lock for the rest of the transaction, so the assignment
 * behind it cannot meet a value another writer moved.
 */
function writeRollup(
  db: Database,
  buckets: RollupBuckets,
  hour: HourReading,
  day: DayReading
): ResultAsync<readonly GrowthLandingClamp[], DomainError> {
  const visitors = [...hour.visitors, ...day.visitors].map((row) => counted(row));
  const paths = [...hour.paths, ...day.paths].map((row) => ({ row, write: countedPath(row) }));
  const referrers = [...hour.referrers, ...day.referrers].map((row) => counted(row));
  const campaignPaths = [...hour.campaignPaths, ...day.campaignPaths].map((row) => counted(row));
  const geo = [...hour.geo, ...day.geo].map((row) => counted(row));
  const events = hour.events.map((row) => counted(row));
  const productEntry = hour.productEntry.map((row) => counted(row));
  const reach = day.reach.map((row) => counted(row));
  const funnel = hour.funnel.map((row) => countedStart(row));
  return fromPromise(
    db.transaction(async (tx) => {
      const clamped: GrowthLandingClamp[] = [];
      for (const write of visitors) {
        await tx
          .insert(growthVisitors)
          .values(write.values)
          .onConflictDoUpdate({
            target: [growthVisitors.grain, growthVisitors.bucket],
            set: write.set,
          });
      }
      for (const { row, write } of paths) {
        clamped.push(...(await clampFor(tx, buckets, row)));
        await tx
          .insert(growthPaths)
          .values(write.values)
          .onConflictDoUpdate({
            target: [growthPaths.grain, growthPaths.bucket, growthPaths.path],
            set: write.set,
          });
      }
      for (const write of referrers) {
        await tx
          .insert(growthReferrers)
          .values(write.values)
          .onConflictDoUpdate({
            target: [
              growthReferrers.grain,
              growthReferrers.bucket,
              growthReferrers.path,
              growthReferrers.referrerHost,
            ],
            set: write.set,
          });
      }
      for (const write of campaignPaths) {
        await tx
          .insert(growthCampaignPaths)
          .values(write.values)
          .onConflictDoUpdate({
            target: [
              growthCampaignPaths.grain,
              growthCampaignPaths.bucket,
              growthCampaignPaths.campaign,
              growthCampaignPaths.path,
            ],
            set: write.set,
          });
      }
      for (const write of geo) {
        await tx
          .insert(growthGeo)
          .values(write.values)
          .onConflictDoUpdate({
            target: [
              growthGeo.grain,
              growthGeo.bucket,
              growthGeo.country,
              growthGeo.region,
              growthGeo.device,
            ],
            set: write.set,
          });
      }
      for (const write of events) {
        await tx
          .insert(growthHourlyEvents)
          .values(write.values)
          .onConflictDoUpdate({
            target: [
              growthHourlyEvents.hour,
              growthHourlyEvents.campaign,
              growthHourlyEvents.eventName,
              growthHourlyEvents.path,
            ],
            set: write.set,
          });
      }
      for (const write of productEntry) {
        await tx
          .insert(growthHourlyProductEntry)
          .values(write.values)
          .onConflictDoUpdate({ target: [growthHourlyProductEntry.hour], set: write.set });
      }
      for (const write of reach) {
        await tx
          .insert(growthDailyPathReach)
          .values(write.values)
          .onConflictDoUpdate({
            target: [
              growthDailyPathReach.day,
              growthDailyPathReach.landingPath,
              growthDailyPathReach.reachedPath,
            ],
            set: write.set,
          });
      }
      for (const write of funnel) {
        await tx
          .insert(growthHourlyFunnel)
          .values(write.values)
          .onConflictDoUpdate({
            target: [growthHourlyFunnel.hour, growthHourlyFunnel.campaign, growthHourlyFunnel.step],
            set: write.set,
          });
      }
      return clamped;
    }),
    (cause) => unavailableError('growth rollup write failed', cause)
  );
}

function rowCountsOf(hour: HourReading, day: DayReading): GrowthRollupRowCounts {
  return {
    visitors: hour.visitors.length + day.visitors.length,
    paths: hour.paths.length + day.paths.length,
    referrers: hour.referrers.length + day.referrers.length,
    campaignPaths: hour.campaignPaths.length + day.campaignPaths.length,
    geo: hour.geo.length + day.geo.length,
    events: hour.events.length,
    productEntry: hour.productEntry.length,
    reach: day.reach.length,
    funnel: hour.funnel.length,
  };
}

/**
 * Reduces one UTC hour of the counting store into the growth tables.
 *
 * The day-grain rows come from the DAY sets rather than from summing the hours
 * already written: a visitor active at nine and again at two is a member of two
 * hourly sets, and summing them would count one person twice.
 */
export function rollupGrowthHour(
  input: GrowthRollupInput
): ResultAsync<GrowthRollupOutcome, DomainError> {
  const buckets = bucketsFor(input.hour);
  return readCampaignTags(input.db)
    .andThen((tags) => readHour(input.redis, buckets, tags))
    .andThen((hour) => {
      if (openedNoKey(hour)) {
        return okAsync<GrowthRollupOutcome, DomainError>(
          pastTheWindow(buckets, input.now) ? { kind: 'lost' } : { kind: 'silent' }
        );
      }
      return readDay(input.redis, buckets).andThen((day) =>
        writeRollup(input.db, buckets, hour, day).map<GrowthRollupOutcome>((clamped) => ({
          kind: 'rolled',
          rows: rowCountsOf(hour, day),
          clamped,
        }))
      );
    });
}

/**
 * Every hour the enqueue reaches back over: the trailing window whose keys the
 * counting store still holds, oldest first, never only the previous hour. A
 * missed scheduled tick is then a hole the next tick fills, rather than a
 * permanent gap nothing pages on.
 */
export function growthRollupWindow(now: Date): readonly string[] {
  const currentHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours()
  );
  const hours: string[] = [];
  for (let back = GROWTH_ROLLUP_WINDOW_HOURS; back >= 1; back -= 1) {
    hours.push(growthHourBucket(new Date(currentHour - back * HOUR_MS)));
  }
  return hours;
}

export interface GrowthRollupJobDeps {
  readonly db: Database;
  /** Resolved inside the handler so a missing binding fails this type's rows and no other's. */
  readonly resolveRedis: () => RedisClient;
  readonly resolveTelemetry: () => Telemetry;
  readonly now: () => Date;
}

/**
 * One capture per row the reduction had to lower, on the channel a scheduled
 * run reaches an operator by.
 *
 * The three coordinates ride as properties rather than in the message, because
 * the Sentry scrub drops the message and rebuilds the event from an allowlist;
 * `sentry-scrub.ts` lifts these keys into tags. A page saying a count was
 * lowered without saying which row names no repair, and one event per row is
 * what lets an operator read the rows rather than a total.
 */
function reportClamped(telemetry: Telemetry, clamped: readonly GrowthLandingClamp[]): void {
  for (const row of clamped) {
    const error = new Error('growth landing count lowered to the visitors a re-roll read');
    Object.assign(error, {
      growthClampedGrain: row.grain,
      growthClampedBucket: row.bucket,
      growthClampedPath: row.path,
    });
    telemetry.captureError(error, FINGERPRINT_CODES.growthLandingCountClamped);
  }
}

/**
 * `growth.rollup.v1` — one hour reduced into the growth tables.
 *
 * `natural` class: every write is an assignment on the row's dimension tuple,
 * so a redelivered row leaves exactly the rows the first delivery did. A lost
 * hour is the one outcome that fails: retrying cannot bring back keys the
 * counting store no longer holds, so the row rides out its budget and
 * dead-letters, which is the channel a never-rolled hour reaches a human on.
 */
export function createGrowthRollupJobRegistration(
  deps: GrowthRollupJobDeps
): OneShotJobRegistration<typeof growthRollupPayloadSchema> {
  return {
    // One hour's reduction is one read per member of an index set, per family
    // per grain. What bounds a set's membership is the per-family ceiling the
    // beacon's write script enforces on the counting store, so the bound lives
    // on that write path and not at this site.
    kind: 'oneShot',
    type: GROWTH_ROLLUP_JOB_TYPE,
    schema: growthRollupPayloadSchema,
    maxExecutionSeconds: GROWTH_ROLLUP_MAX_EXECUTION_SECONDS,
    maxFailures: GROWTH_ROLLUP_MAX_FAILURES,
    idempotency: 'natural',
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { hour } = execution.payload;
      // Every dependency resolved at entry, the reporting channel with the
      // rest: what a pass holds must not depend on which outcome it reaches.
      const telemetry = deps.resolveTelemetry();
      const rolled = await rollupGrowthHour({
        db: deps.db,
        redis: deps.resolveRedis(),
        hour,
        now: deps.now(),
      });
      return rolled.match(
        (outcome) => {
          if (outcome.kind === 'lost') return jobOutcome.fail(GROWTH_ROLLUP_HOUR_LOST);
          if (outcome.kind === 'rolled') {
            reportClamped(telemetry, outcome.clamped);
          }
          return jobOutcome.ok({
            hour,
            rows: outcome.kind === 'rolled' ? outcome.rows : NO_ROWS,
          });
        },
        (error) => jobOutcome.fail(error.code)
      );
    },
  };
}

export interface GrowthRollupEnqueueDeps {
  /** Capability-bearing so the enqueue leaves its wake on the cron's scope. */
  readonly db: JobWakeCapable<Database>;
  /** Supplies the registered schema, lease and shard the enqueue reads; the handler is never reached. */
  readonly resolveRegistry: () => JobRegistry;
  readonly now: () => Date;
}

/**
 * The cron half: one INSERT per hour of the trailing window, in one
 * transaction, and nothing else — cron enqueues, the dispatcher delivers.
 * The per-hour dedupe key covers a duplicate invocation while a row is still
 * pending or running; a finished row never blocks the next tick, which is what
 * lets the day rows keep converging as the day fills.
 */
export function createGrowthRollupEnqueueEntry(deps: GrowthRollupEnqueueDeps): CronEntry {
  return {
    name: 'growth-rollup-enqueue',
    run: async (): Promise<void> => {
      const registry = deps.resolveRegistry();
      const hours = growthRollupWindow(deps.now());
      await runWithJobWakes(deps.db, (collected) =>
        deps.db.transaction(async (tx) => {
          const writer = grantJobWakes(tx, collected);
          for (const hour of hours) {
            await enqueueWithinTx(writer, registry, {
              type: GROWTH_ROLLUP_JOB_TYPE,
              payload: { hour },
              dedupeKey: `${GROWTH_ROLLUP_JOB_TYPE}:${hour}`,
            });
          }
        })
      );
    },
  };
}
