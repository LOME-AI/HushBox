import { z } from 'zod';
import { defineKey } from './define-key.js';

/**
 * The growth counters' Redis key registry: every key the anonymous half of
 * growth measurement writes, and the encoding its index-set members carry.
 *
 * It lives beside the registry mechanism rather than inside the growth slice
 * because two slices address these keys — the beacon writes them and the
 * rollup reads them back — and a second spelling of a key on either side would
 * be a set nobody reads or a row nobody writes.
 *
 * The rule a family here is held to: an identifier these keys carry — a
 * visitor hash, a day-keyed address identity — reaches no row and no log, and a set of
 * them can leave Redis only as a cardinality. The dimension values an index
 * member carries do reach rows; the rollup enumerates an index to recover them.
 * The TTL below is the only prune there is.
 */

/**
 * The window every bucketed growth key is held for. Long enough that a rollup
 * which missed its hour can still be redriven from a trailing window of hours.
 *
 * A length, not a deadline: when it starts running is a property of the write
 * that applies it, and `addUnderCeiling`
 * (`apps/api/src/slices/growth/domain/ceiling-gate.ts`) is where that is
 * stated.
 */
export const GROWTH_REDIS_TTL_SECONDS = 36 * 60 * 60;

/**
 * How long the active-campaign tags are trusted before the registry is read
 * from Postgres again. Short because it decides whether a live campaign's tag
 * counts under its own name or folds to `unknown`, and a minted campaign must
 * start counting without a deploy.
 */
const ACTIVE_CAMPAIGNS_TTL_SECONDS = 5 * 60;

/** The two grains a bucketed family is written at, as they appear in a key. */
export type GrowthGrainKey = 'h' | 'd';

/**
 * The index-set families. Each names the set of distinct dimension values seen
 * in one bucket, which is what the rollup enumerates instead of scanning the
 * keyspace, and which the per-family ceiling bounds.
 *
 * `paths` covers the view and landing sets together: both are keyed by path
 * alone and produce the two columns of one row, so one index answers for both.
 */
export const GROWTH_INDEX_FAMILIES = [
  'paths',
  'referrers',
  'campaigns',
  'geo',
  'events',
  'reach',
] as const;

export type GrowthIndexFamily = (typeof GROWTH_INDEX_FAMILIES)[number];

/**
 * The field separator inside an index-set member.
 *
 * A member encodes several dimension values, and the obvious delimiters are
 * all legal INSIDE one: an auto-captured event name is `link:/signup`, so it
 * carries both `:` and `/`; a referrer host carries `.` and `-`. Splitting on
 * any of them tears one value in half and files its counts under a dimension
 * nobody wrote — a wrong number rather than an error, which nothing downstream
 * can detect. The unit separator appears in no growth pattern, so no legal
 * value can forge a field boundary, and {@link encodeGrowthIndexMember}
 * refuses one that tries.
 */
const INDEX_MEMBER_SEPARATOR = '\u001F';

/**
 * One index-set member from its dimension values, in the family's own order.
 * The single encoder: the beacon writes members through it and the rollup
 * reads them back through {@link decodeGrowthIndexMember}, so neither side
 * spells the boundary itself.
 */
export function encodeGrowthIndexMember(values: readonly string[]): string {
  for (const value of values) {
    if (value.includes(INDEX_MEMBER_SEPARATOR)) {
      throw new Error('growth index member: a dimension value may not contain the separator');
    }
  }
  return values.join(INDEX_MEMBER_SEPARATOR);
}

/**
 * The dimension values an index-set member carries, in the family's own order.
 * `fields` is the arity the caller expects: a member of another arity is a
 * member of another family, and reading it as this one would attribute its
 * counts to the wrong dimensions.
 *
 * The three overloads answer at the arity the caller asked for, which every
 * growth family uses. They are sound because the body refuses any other arity
 * before returning: a caller asking for two fields either gets two or gets a
 * throw. Without them the answer is a list, and a list read positionally is
 * `string | undefined` at every position — an unreachable branch per dimension
 * in the very code whose job is to say which dimension a count belongs to.
 */
export function decodeGrowthIndexMember(member: string, fields: 1): readonly [string];
export function decodeGrowthIndexMember(member: string, fields: 2): readonly [string, string];
export function decodeGrowthIndexMember(
  member: string,
  fields: 3
): readonly [string, string, string];
export function decodeGrowthIndexMember(member: string, fields: number): readonly string[] {
  const values = member.split(INDEX_MEMBER_SEPARATOR);
  if (values.length !== fields) {
    throw new Error(
      `growth index member: expected ${String(fields)} fields, found ${String(values.length)}`
    );
  }
  return values;
}

/** The namespace every key of one bucket sits under. */
function bucketPrefix(grain: GrowthGrainKey, bucket: string): string {
  return `growth:${grain}:${bucket}:`;
}

/**
 * Where a visitor was, as coarsely as this design ever knows it: a country, a
 * US state where the country is `US`, and a device family. The three travel as
 * one value because they name one row and one set between them, and passing
 * them separately is how two of the three end up in the wrong order.
 */
export interface GrowthPlace {
  readonly country: string;
  readonly region: string;
  readonly device: string;
}

/** A set's name inside its bucket — also the field its overflow flag is filed under. */
const setNames = {
  visitors: (): string => 'visitors',
  views: (path: string): string => `views:${path}`,
  landings: (path: string): string => `landings:${path}`,
  referrers: (path: string, host: string): string => `refs:${path}:${host}`,
  campaignPaths: (campaign: string, path: string): string => `camp:${campaign}:${path}`,
  geo: (place: GrowthPlace): string => `geo:${place.country}:${place.region}:${place.device}`,
  events: (campaign: string, event: string, path: string): string =>
    `events:${campaign}:${event}:${path}`,
  productEntry: (): string => 'product-entry',
  reach: (landingPath: string, reachedPath: string): string =>
    `reach:${landingPath}:${reachedPath}`,
  started: (campaign: string): string => `started:${campaign}`,
  startedDecoy: (campaign: string): string => `started-decoy:${campaign}`,
} as const;

/** A set of visitor hashes: 32 lowercase hex characters, the truncated daily HMAC. */
const visitorHashMember = z.string().regex(/^[\da-f]{32}$/u);

/** A set of day-keyed address identities: 64 lowercase hex characters, the whole daily HMAC. */
const addressIdMember = z.string().regex(/^[\da-f]{64}$/u);

/**
 * Every growth key, with the value its members carry and the lifetime it gets.
 * `setName` sits beside `buildKey` wherever a family has an overflow flag: the
 * flag's field is the set's own name, so the two are built from one expression
 * and a renamed key moves its flag with it.
 */
export const GROWTH_REDIS_KEYS = {
  /** Distinct visitors in a bucket. The day set's first add for a hash is that visitor's first sight today. */
  visitors: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string) =>
        `${bucketPrefix(grain, bucket)}${setNames.visitors()}`,
    }),
    setName: setNames.visitors,
  },

  /** Distinct visitors who viewed one path. */
  views: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string, path: string) =>
        `${bucketPrefix(grain, bucket)}${setNames.views(path)}`,
    }),
    setName: setNames.views,
  },

  /** Distinct visitors whose first page today was one path. */
  landings: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string, path: string) =>
        `${bucketPrefix(grain, bucket)}${setNames.landings(path)}`,
    }),
    setName: setNames.landings,
  },

  /** Distinct visitors who reached one path from one referrer host. */
  referrers: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string, path: string, host: string) =>
        `${bucketPrefix(grain, bucket)}${setNames.referrers(path, host)}`,
    }),
    setName: setNames.referrers,
  },

  /** Distinct visitors who viewed one path under one campaign tag. */
  campaignPaths: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string, campaign: string, path: string) =>
        `${bucketPrefix(grain, bucket)}${setNames.campaignPaths(campaign, path)}`,
    }),
    setName: setNames.campaignPaths,
  },

  /** Distinct visitors per country, US state and coarse device family. */
  geo: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (grain: GrowthGrainKey, bucket: string, place: GrowthPlace) =>
        `${bucketPrefix(grain, bucket)}${setNames.geo(place)}`,
    }),
    setName: setNames.geo,
  },

  /**
   * Distinct visitors who fired one named event on one page under one campaign
   * — people, never clicks. Hour grain only: an event is an event in time, and
   * the daily marginals the marketer reads are the visitor dimensions.
   */
  events: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (hour: string, campaign: string, event: string, path: string) =>
        `${bucketPrefix('h', hour)}${setNames.events(campaign, event, path)}`,
    }),
    setName: setNames.events,
  },

  /**
   * Distinct visitors who clicked into the product in an hour, under no
   * campaign at all — the marginal across the campaign-keyed event sets, which
   * is not recoverable from them: set cardinalities are not additive, so one
   * visitor who arrives under two tags is one person here and two there.
   *
   * Hour grain only, like the event family it is the marginal of. Its members
   * are a subset of the same hour's visitor set, because a beacon that adds
   * here adds there too.
   */
  productEntry: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (hour: string) => `${bucketPrefix('h', hour)}${setNames.productEntry()}`,
    }),
    setName: setNames.productEntry,
  },

  /**
   * One visitor's first path today — a single path claimed by `SET NX`, never
   * a clickstream. It is what names the reach family's landing dimension, and
   * it is the one growth key whose identity is a visitor rather than an
   * aggregate dimension.
   */
  landing: defineKey({
    schema: z.string(),
    ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
    buildKey: (day: string, visitorHash: string) =>
      `${bucketPrefix('d', day)}landing:${visitorHash}`,
  }),

  /** Distinct visitors who landed on one path today and reached another. Day grain: a journey is same-day by construction. */
  reach: {
    ...defineKey({
      schema: visitorHashMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (day: string, landingPath: string, reachedPath: string) =>
        `${bucketPrefix('d', day)}${setNames.reach(landingPath, reachedPath)}`,
    }),
    setName: setNames.reach,
  },

  /** Distinct addresses that began registration in an hour, under a campaign tag. */
  started: {
    ...defineKey({
      schema: addressIdMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (hour: string, campaign: string) =>
        `${bucketPrefix('h', hour)}${setNames.started(campaign)}`,
    }),
    setName: setNames.started,
  },

  /**
   * The shadow set the existing-email decoy path writes and nothing reads.
   * Written rather than skipped: a branch that skipped one Redis call would
   * add a timing side channel to an enumeration defence — which is also why it
   * carries a flag field of its own: the two branches run the same script over
   * the same ceiling, so a refusal costs each of them the same commands.
   */
  startedDecoy: {
    ...defineKey({
      schema: addressIdMember,
      ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
      buildKey: (hour: string, campaign: string) =>
        `${bucketPrefix('h', hour)}${setNames.startedDecoy(campaign)}`,
    }),
    setName: setNames.startedDecoy,
  },

  /**
   * The visitor identities one address minted today, bounded by the mint
   * ceiling the write script checks before it counts anything.
   *
   * The identity is a keyed hash over the address AND the user agent, so the
   * address alone does not bound it: the user agent is the sender's to vary,
   * and without this set one address could open a new identity per beacon and
   * fill the day's visitor set on its own. Keyed by the address's day-keyed
   * identity in this set, never by an unkeyed digest: a key name an IPv4
   * enumeration reverses would file each visitor code under its address.
   */
  mint: defineKey({
    schema: visitorHashMember,
    ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
    buildKey: (day: string, mintId: string) => `${bucketPrefix('d', day)}mint:${mintId}`,
  }),

  /**
   * The latch that makes one address's daily identity budget report once.
   *
   * Two writes take it, whichever arrives first: the admitted add that FILLS
   * the budget, and a refusal that meets a full budget this key does not
   * already cover. `SET NX` is what makes them one report. Past the mint
   * ceiling that address's beacons under identities it has not already minted
   * are dropped, one after another for the rest of the day, and a Worker holds
   * no memory between requests — so without this the alert would fire per
   * dropped beacon, which is the throttle's whole allowance turned into Sentry
   * events. Separate from the sets' overflow hash on purpose: that hash
   * carries the flags the rollup copies onto rows, and nothing here reaches a
   * row.
   */
  mintCapped: defineKey({
    schema: z.literal(1),
    ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
    buildKey: (day: string, mintCappedId: string) =>
      `${bucketPrefix('d', day)}mint-capped:${mintCappedId}`,
  }),

  /** The distinct dimension values one family opened in one bucket, encoded by {@link encodeGrowthIndexMember}. */
  index: defineKey({
    schema: z.string(),
    ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
    buildKey: (grain: GrowthGrainKey, bucket: string, family: GrowthIndexFamily) =>
      `${bucketPrefix(grain, bucket)}idx:${family}`,
  }),

  /**
   * The bucket's overflow flags: set name to `1`, one field per set that
   * refused a member at its ceiling. The field is also the latch that makes
   * the alert fire once — a Worker holds no memory between requests, so
   * "already flagged" is the only thing that can say "already reported".
   *
   * The flag reads back as a number: the script writes the string Redis holds,
   * and the client JSON-parses what it returns.
   */
  overflow: defineKey({
    schema: z.literal(1),
    ttlSeconds: GROWTH_REDIS_TTL_SECONDS,
    buildKey: (grain: GrowthGrainKey, bucket: string) => `${bucketPrefix(grain, bucket)}overflow`,
  }),

  /**
   * The active campaign tags, as one encoded member list. A beacon validates
   * its tag against this rather than against Postgres, so a flood of beacons
   * costs one database read per TTL rather than one per request.
   */
  activeCampaigns: defineKey({
    schema: z.array(z.string()),
    ttlSeconds: ACTIVE_CAMPAIGNS_TTL_SECONDS,
    buildKey: () => 'growth:campaigns:active',
  }),
} as const;
