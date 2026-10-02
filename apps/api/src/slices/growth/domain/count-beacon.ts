import { z } from 'zod';
import { PRODUCT_ENTRY_ROUTES, productEntryEventNames } from '@hushbox/shared';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  encodeGrowthIndexMember,
  growthDayBucket,
  growthHourBucket,
  redisEval,
  redisGet,
} from '../../../lib/redis/index.js';
import { BEACON_REPLY_SEPARATOR, BEACON_SCRIPT, BEACON_STATUS } from './beacon-script.js';
import type { GrowthGrainKey, GrowthIndexFamily, GrowthPlace } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Variables } from '../../../lib/context/index.js';
import type { GrowthDevice } from '@hushbox/shared';

/**
 * One beacon, counted.
 *
 * Every marginal this writes is a SET of visitor hashes, never a counter: a
 * visitor who views a page ten times in an hour is one member of that hour's
 * view set, and a visitor who clicks a button a thousand times is one member of
 * that event set. That is the honest metric — how many people, not how many
 * clicks — and it is also what makes a duplicated delivery converge, which is
 * what the route's idempotency exemption rests on.
 *
 * Each counted family is keyed by exactly the dimensions of the row it
 * produces, and each is a MARGINAL. Set cardinalities are not additive across a cross
 * product, so a distinct count over "campaign × path × referrer" cannot be
 * recovered from distinct counts of its projections; every question the
 * dashboard asks therefore has its own family.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/**
 * The abuse bounds this write enforces. `set` bounds how many members any one
 * set may hold in a bucket; `index` bounds how many distinct dimension values a
 * family may open there, and a family with no entry is bounded by the built
 * page-and-event allowlist instead, which is tighter than a number would be;
 * `mint` bounds how many distinct visitor identities one address may produce in
 * a day — the identity is a keyed hash over the address and the user agent, and
 * the user agent is the sender's to vary, so the address alone bounds nothing.
 */
export interface GrowthCeilings {
  readonly set: number;
  readonly mint: number;
  readonly index: Readonly<Partial<Record<GrowthIndexFamily, number>>>;
}

/** What one beacon counts, after the route has validated and normalised all of it. */
export interface BeaconCount {
  readonly kind: 'view' | 'event';
  /** The built marketing page the beacon names. */
  readonly path: string;
  /** The referrer host, absent when the page was not reached from one. */
  readonly referrerHost: string | undefined;
  /** The campaign tag, already resolved against the active set — `direct` or `unknown` when it names none. */
  readonly campaign: string;
  /** The derived event name, present exactly when `kind` is `event`. */
  readonly eventName: string | undefined;
  readonly country: string;
  readonly region: string;
  readonly device: GrowthDevice;
  /** The day-keyed visitor hash. It exists here, in Redis, and nowhere else. */
  readonly visitor: string;
  /** The day-keyed identity of the address this beacon's visitor hash was minted under, in the mint set. */
  readonly mintId: string;
  /** The same address's day-keyed identity in the mint-capped latch, which no other key shares. */
  readonly mintCappedId: string;
  /** Server arrival time. Both buckets are derived from it, so no caller can choose which hour it lands in. */
  readonly at: Date;
  readonly ceilings: GrowthCeilings;
}

/** The catch-all a path folds to past the paths ceiling. Satisfies the path column check. */
const OTHER_PATH = '/other';

/** The catch-all a referrer host folds to. Satisfies the hostname column check. */
const OTHER_HOST = 'other';

/** The catch-all an event name folds to. Satisfies the event-name column check. */
const OTHER_EVENT = 'other';

/** The catch-all a geography folds to: a device family of `other` in no country and no state. */
const OTHER_GEO = { country: '', region: '', device: 'other' } as const;

/**
 * The event names that mean the visitor entered the product. Derived at load
 * from the destinations rather than listed, so the set this beacon fills and
 * the filter the funnel view reads are one answer; a route that derives no
 * legal name fails the isolate here rather than counting nothing.
 */
const PRODUCT_ENTRY_EVENT_NAMES: ReadonlySet<string> = new Set(
  productEntryEventNames(PRODUCT_ENTRY_ROUTES)
);

/**
 * What must already hold for an op to run. `''` is unconditional; `lh` and
 * `ld` are the landing sets, which need the visitor's first sight today and the
 * same grain's view add; `rm` is the reach set, which needs the landing the
 * key was built from to be the one that won the claim.
 */
type OpDependency = '' | 'lh' | 'ld' | 'rm';

/** What an op reports back to its dependents: first sight, or an admitted view at one grain. */
type OpRecord = '' | 'first' | 'vh' | 'vd';

interface BeaconOp {
  readonly enabled: boolean;
  readonly dep: OpDependency;
  readonly record: OpRecord;
  /** The set as the beacon's own dimensions name it. */
  readonly naturalKey: string;
  /** The set the family folds to when its index is full. Equal to `naturalKey` for a family that never folds. */
  readonly foldedKey: string;
  /** The set's own name inside its bucket, which is also its overflow field. */
  readonly naturalField: string;
  readonly foldedField: string;
  /** Which grain's overflow hash this op's flag belongs in. */
  readonly grain: GrowthGrainKey;
  /** The index family this op's dimensions belong to, absent for a family with no index. */
  readonly family: GrowthIndexFamily | undefined;
  readonly indexKey: string;
  readonly naturalMember: string;
  readonly foldedMember: string;
}

/** One grain, and the bucket that grain labels this beacon with. */
type Grain = readonly [GrowthGrainKey, string];

/**
 * A family with no index: a set whose only dimension is its bucket, so it opens
 * no dimension value and nothing about it can fold.
 */
function unindexed(op: {
  readonly enabled: boolean;
  readonly grain: GrowthGrainKey;
  readonly record: OpRecord;
  readonly key: string;
  readonly field: string;
}): BeaconOp {
  return {
    enabled: op.enabled,
    dep: '',
    record: op.record,
    naturalKey: op.key,
    foldedKey: op.key,
    naturalField: op.field,
    foldedField: op.field,
    grain: op.grain,
    family: undefined,
    indexKey: op.key,
    naturalMember: '',
    foldedMember: '',
  };
}

/**
 * A family whose set folds to a catch-all when its index is full.
 *
 * `Values` is the family's dimension tuple at its own FIXED arity, inferred
 * from the `as const` literal each caller passes. That is what lets the key and
 * field builders below destructure every position totally: typed as a bare
 * list, each read would need a fallback the compiler's index-safety setting
 * demands and that no input could ever reach — unreachable branches in the one
 * module whose job is to be exact about which dimensions a row carries.
 */
function indexed<Values extends readonly string[]>(op: {
  readonly enabled: boolean;
  readonly dep: OpDependency;
  readonly record: OpRecord;
  readonly grain: GrowthGrainKey;
  readonly bucket: string;
  readonly family: GrowthIndexFamily;
  readonly natural: Values;
  readonly folded: Values;
  readonly key: (values: Values) => string;
  readonly field: (values: Values) => string;
}): BeaconOp {
  return {
    enabled: op.enabled,
    dep: op.dep,
    record: op.record,
    naturalKey: op.key(op.natural),
    foldedKey: op.key(op.folded),
    naturalField: op.field(op.natural),
    foldedField: op.field(op.folded),
    grain: op.grain,
    family: op.family,
    indexKey: GROWTH_REDIS_KEYS.index.buildKey(op.grain, op.bucket, op.family),
    naturalMember: encodeGrowthIndexMember(op.natural),
    foldedMember: encodeGrowthIndexMember(op.folded),
  };
}

/** The two path-keyed sets of one grain: who viewed a page, and who landed on it. */
function pathOps(count: BeaconCount, [grain, bucket]: Grain, view: boolean): BeaconOp[] {
  const shared = {
    grain,
    bucket,
    family: 'paths',
    natural: [count.path] as const,
    folded: [OTHER_PATH] as const,
  } as const;
  return [
    indexed({
      ...shared,
      enabled: view,
      dep: '',
      record: grain === 'h' ? 'vh' : 'vd',
      key: ([path]) => GROWTH_REDIS_KEYS.views.buildKey(grain, bucket, path),
      field: ([path]) => GROWTH_REDIS_KEYS.views.setName(path),
    }),
    // Landings share the paths index with views, so the two agree on a fold by
    // reading one index rather than by keeping two decisions in step.
    indexed({
      ...shared,
      enabled: view,
      dep: grain === 'h' ? 'lh' : 'ld',
      record: '',
      key: ([path]) => GROWTH_REDIS_KEYS.landings.buildKey(grain, bucket, path),
      field: ([path]) => GROWTH_REDIS_KEYS.landings.setName(path),
    }),
  ];
}

/** The geography triple, named. */
function placeOf([country, region, device]: readonly [string, string, string]): GrowthPlace {
  return { country, region, device };
}

/** The three dimension-keyed sets of one grain: referrer, campaign and geography. */
function dimensionOps(count: BeaconCount, [grain, bucket]: Grain, view: boolean): BeaconOp[] {
  const host = count.referrerHost ?? OTHER_HOST;
  const geo = [count.country, count.region, count.device] as const;
  const otherGeo = [OTHER_GEO.country, OTHER_GEO.region, OTHER_GEO.device] as const;
  return [
    // A FOLD DOES NOT CASCADE. This key keeps the real path even when the
    // paths family folded that same path to its catch-all, because folding
    // here too would need the cross product of candidate keys — four per
    // grain instead of two — to guard a case the exact-page allowlist already
    // makes near-unreachable. So a path can appear in this family that the
    // paths family never admitted; both spellings satisfy their column checks,
    // and the tables are independent marginals, so no row is made unwritable
    // by the difference.
    indexed({
      grain,
      bucket,
      enabled: view && count.referrerHost !== undefined,
      dep: '',
      record: '',
      family: 'referrers',
      natural: [count.path, host] as const,
      folded: [count.path, OTHER_HOST] as const,
      key: ([path, source]) => GROWTH_REDIS_KEYS.referrers.buildKey(grain, bucket, path, source),
      field: ([path, source]) => GROWTH_REDIS_KEYS.referrers.setName(path, source),
    }),
    // The campaign family carries no ceiling: the set of live tags is what an
    // operator minted, which bounds it more tightly than a number would.
    indexed({
      grain,
      bucket,
      enabled: view,
      dep: '',
      record: '',
      family: 'campaigns',
      natural: [count.campaign, count.path] as const,
      folded: [count.campaign, count.path] as const,
      key: ([campaign, path]) =>
        GROWTH_REDIS_KEYS.campaignPaths.buildKey(grain, bucket, campaign, path),
      field: ([campaign, path]) => GROWTH_REDIS_KEYS.campaignPaths.setName(campaign, path),
    }),
    indexed({
      grain,
      bucket,
      enabled: view,
      dep: '',
      record: '',
      family: 'geo',
      natural: geo,
      folded: otherGeo,
      key: (values) => GROWTH_REDIS_KEYS.geo.buildKey(grain, bucket, placeOf(values)),
      field: (values) => GROWTH_REDIS_KEYS.geo.setName(placeOf(values)),
    }),
  ];
}

/** Every op of one beacon, in the order the script's dependencies require. */
function opsFor(count: BeaconCount, hour: string, day: string, landing: string): BeaconOp[] {
  const view = count.kind === 'view';
  const grains: readonly Grain[] = [
    ['h', hour],
    ['d', day],
  ];
  const eventName = count.eventName ?? OTHER_EVENT;
  const entryClick =
    count.kind === 'event' &&
    count.eventName !== undefined &&
    PRODUCT_ENTRY_EVENT_NAMES.has(count.eventName);

  return [
    // The visitor sets first: the day set's answer is what every landing op
    // depends on.
    ...grains.map(([grain, bucket]) =>
      unindexed({
        enabled: true,
        grain,
        record: grain === 'd' ? 'first' : '',
        key: GROWTH_REDIS_KEYS.visitors.buildKey(grain, bucket),
        field: GROWTH_REDIS_KEYS.visitors.setName(),
      })
    ),
    ...grains.flatMap((grain) => pathOps(count, grain, view)),
    ...grains.flatMap((grain) => dimensionOps(count, grain, view)),
    indexed({
      grain: 'd',
      bucket: day,
      enabled: view,
      dep: 'rm',
      record: '',
      family: 'reach',
      natural: [landing, count.path] as const,
      folded: [landing, OTHER_PATH] as const,
      key: ([from, to]) => GROWTH_REDIS_KEYS.reach.buildKey(day, from, to),
      field: ([from, to]) => GROWTH_REDIS_KEYS.reach.setName(from, to),
    }),
    indexed({
      grain: 'h',
      bucket: hour,
      enabled: count.kind === 'event',
      dep: '',
      record: '',
      family: 'events',
      natural: [count.campaign, eventName, count.path] as const,
      folded: [count.campaign, OTHER_EVENT, count.path] as const,
      key: ([campaign, name, path]) =>
        GROWTH_REDIS_KEYS.events.buildKey(hour, campaign, name, path),
      field: ([campaign, name, path]) => GROWTH_REDIS_KEYS.events.setName(campaign, name, path),
    }),
    // Who entered the product this hour, under no campaign at all. The
    // campaign-keyed event sets cannot answer it: they are cardinalities, so
    // one visitor arriving under two tags is one person here and a member of
    // each of them. Decided on the name the beacon derived rather than on the
    // one the events family folds to at its ceiling, so a click whose name
    // folded is still counted here.
    unindexed({
      enabled: entryClick,
      grain: 'h',
      record: '',
      key: GROWTH_REDIS_KEYS.productEntry.buildKey(hour),
      field: GROWTH_REDIS_KEYS.productEntry.setName(),
    }),
  ];
}

/** The reply: the beacon's status, then the overflow fields it latched for the first time. */
const replySchema = z.string();

/**
 * What one beacon's write amounted to: the flags it latched and whether it
 * filled the address's daily identity budget, or the drop that budget answered
 * it with.
 */
export type BeaconWrite =
  | {
      readonly kind: 'counted';
      readonly overflowed: readonly string[];
      /**
       * Whether this beacon's identity is the one that filled the address's
       * daily budget. True on the beacon that brings the address to its
       * ceiling, which is counted rather than refused.
       */
      readonly mintFilled: boolean;
    }
  | { readonly kind: 'capped'; readonly firstToday: boolean };

/**
 * The script's reply, read at the layout {@link BEACON_STATUS} documents.
 *
 * Two of the four statuses mean counted and two mean dropped; anything else is
 * read as a drop, which is the safe side — a reply this cannot recognise
 * counts nothing rather than being reported as a count.
 */
function readReply(reply: string): BeaconWrite {
  const [status, ...overflowed] = reply.split(BEACON_REPLY_SEPARATOR);
  if (status === BEACON_STATUS.counted || status === BEACON_STATUS.countedFull) {
    return { kind: 'counted', overflowed, mintFilled: status === BEACON_STATUS.countedFull };
  }
  return { kind: 'capped', firstToday: status === BEACON_STATUS.cappedFirst };
}

/**
 * Counts one beacon.
 *
 * The landing path is read before the script rather than derived inside it,
 * because the reach set is keyed by the pair (landed on, reached) and every key
 * a script touches has to be passed in. The read is advisory and the script
 * closes the race it opens: it claims the landing key itself, compares what
 * actually won against the value this key was built from, and skips the reach
 * add when they differ — so two first page views racing lose one reach member
 * rather than filing it against a path the visitor never landed on.
 *
 * The answer is either that the beacon counted — carrying the overflow flags
 * it newly latched, each as its grain and the set that filled, one per set per
 * bucket, an empty list being the ordinary case, and whether this identity is
 * the one that filled the address's daily budget — or the drop the mint
 * ceiling answers an identity the address has not already minted, which counts
 * nothing. The fill and the drop write one day latch between them, so an
 * address's budget reports once rather than once per beacon.
 */
export function countBeacon(
  redis: RedisClient,
  count: BeaconCount
): ResultAsync<BeaconWrite, DomainError> {
  const hour = growthHourBucket(count.at);
  const day = growthDayBucket(count.at);
  const view = count.kind === 'view';

  return redisGet(redis, GROWTH_REDIS_KEYS.landing, day, count.visitor)
    .map((stored) => stored ?? count.path)
    .andThen((landing) => {
      const ops = opsFor(count, hour, day, landing);
      // The two arrays below ARE the wire layout `BEACON_SCRIPT` reads by
      // offset. Their strides come from `BEACON_WIRE`, which the script
      // interpolates too, so neither side carries a stride the other could
      // drift from — but the FIELD ORDER within an op is still an agreement by
      // reading, held by the integration tests, since a swap writes the wrong
      // key rather than failing.
      const keys = [
        GROWTH_REDIS_KEYS.landing.buildKey(day, count.visitor),
        GROWTH_REDIS_KEYS.overflow.buildKey('h', hour),
        GROWTH_REDIS_KEYS.overflow.buildKey('d', day),
        GROWTH_REDIS_KEYS.mint.buildKey(day, count.mintId),
        GROWTH_REDIS_KEYS.mintCapped.buildKey(day, count.mintCappedId),
        ...ops.flatMap((op) => [op.naturalKey, op.foldedKey, op.indexKey]),
      ];
      const args = [
        String(GROWTH_REDIS_TTL_SECONDS),
        String(count.ceilings.set),
        count.visitor,
        landing,
        view ? count.path : '',
        String(ops.length),
        String(count.ceilings.mint),
        ...ops.flatMap((op) => [
          op.enabled ? '1' : '0',
          op.dep,
          op.record,
          op.family === undefined ? '0' : '1',
          String(op.family === undefined ? 0 : (count.ceilings.index[op.family] ?? 0)),
          op.naturalMember,
          op.foldedMember,
          op.grain,
          op.naturalField,
          op.foldedField,
        ]),
      ];
      return redisEval(redis, {
        script: BEACON_SCRIPT,
        reply: replySchema,
        keys,
        args,
      }).map((reply) => readReply(reply));
    });
}
