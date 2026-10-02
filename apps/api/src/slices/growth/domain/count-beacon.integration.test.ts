import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { PRODUCT_ENTRY_ROUTES, productEntryEventNames } from '@hushbox/shared';
import {
  GROWTH_REDIS_KEYS,
  encodeGrowthIndexMember,
  growthDayBucket,
  growthHourBucket,
  redisGet,
  redisHGetAll,
  redisScard,
  redisSmembers,
} from '../../../lib/redis/index.js';
import { growthTestDays } from '../../../test-support/growth-test-days.js';
import { BEACON_SCRIPT, BEACON_STATUS, BEACON_WIRE } from './beacon-script.js';
import { countBeacon } from './count-beacon.js';
import type { BeaconCount, BeaconWrite, GrowthCeilings } from './count-beacon.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for growth counter integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** A client whose every call fails fast: nothing listens on the discard port. */
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const created = new Set<string>();

afterAll(async () => {
  if (created.size > 0) await redis.del(...created);
});

/** Records a key so the suite deletes exactly what it wrote and nothing else. */
function track(key: string): string {
  created.add(key);
  return key;
}

/** The one place every case in this file counts from. */
const HERE = { country: 'US', region: 'CA', device: 'desktop' } as const;

const CEILINGS: GrowthCeilings = {
  set: 100_000,
  mint: 1000,
  index: { paths: 500, referrers: 1000 },
};

/** Sixteen random bytes as hex — the shape a real visitor hash has. */
function visitor(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** Thirty-two random bytes as hex — the shape a day-keyed address identity has. */
function addressId(): string {
  return `${visitor()}${visitor()}`;
}

/** One address's identities in the mint set and the mint-capped latch, which never coincide. */
interface AddressIds {
  readonly mintId: string;
  readonly mintCappedId: string;
}

function address(): AddressIds {
  return { mintId: addressId(), mintCappedId: addressId() };
}

/** A short random label, so no two cases in this file can address one key. */
function label(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Where this file's cases sit: a lane of its own, measured from the day the run
 * is happening on. A bucket-global key — the visitor sets, the index sets, the
 * overflow hash — is addressed by its bucket and nothing else, and every growth
 * test file in a run shares one Redis keyspace, so a day two of them both name
 * has each reading the other's members. A lane makes that impossible; the draw
 * this replaces only made it unlikely.
 */
const DAYS = growthTestDays('count-beacon', new Date());

/** The day indices cases in this file have already claimed. */
const daysTaken = new Set<number>();

/**
 * A whole UTC day to itself per case. Same reason as {@link DAYS}, one level
 * down: two cases sharing a day would read each other's members. A day already
 * claimed is refused here, because a shared day stays invisible for as long as
 * one of the two cases happens to write nothing to the day-global keys both of
 * them address.
 */
function dayApart(index: number): Date {
  if (daysTaken.has(index)) {
    throw new Error(`another case in this file already counts on ${String(index)}`);
  }
  daysTaken.add(index);
  return DAYS.clean(index);
}

interface Scene {
  readonly at: Date;
  readonly hour: string;
  readonly day: string;
  readonly path: string;
  readonly campaign: string;
  readonly host: string;
  readonly visitor: string;
  readonly address: AddressIds;
}

function scene(dayIndex: number): Scene {
  const at = dayApart(dayIndex);
  return {
    at,
    hour: growthHourBucket(at),
    day: growthDayBucket(at),
    path: `/p-${label()}`,
    campaign: `c-${label()}`,
    host: `h${label()}.example.com`,
    visitor: visitor(),
    address: address(),
  };
}

function pageView(s: Scene, overrides: Partial<BeaconCount> = {}): BeaconCount {
  return {
    kind: 'view',
    path: s.path,
    referrerHost: s.host,
    campaign: s.campaign,
    eventName: undefined,
    country: 'US',
    region: 'CA',
    device: 'desktop',
    visitor: s.visitor,
    ...s.address,
    at: s.at,
    ceilings: CEILINGS,
    ...overrides,
  };
}

/**
 * One product-entry click of a scene, as the route hands it to the counter.
 * The name comes from the derivation the beacon itself decides by, never
 * spelled here: a literal would be a second spelling of the same name, and the
 * two would have to agree for the case to mean anything.
 */
function entryClick(s: Scene, overrides: Partial<BeaconCount> = {}): BeaconCount {
  return pageView(s, {
    kind: 'event',
    eventName: productEntryName(),
    referrerHost: undefined,
    ...overrides,
  });
}

/** The name a click on the first product-entry destination derives. */
function productEntryName(): string {
  const [name] = productEntryEventNames(PRODUCT_ENTRY_ROUTES);
  if (name === undefined) throw new Error('the product-entry routes derive no event name');
  return name;
}

/** The named keys of one page view of a scene. */
type PageViewKeys = Readonly<Record<PageViewKeyName, string>>;

type PageViewKeyName =
  | 'hourVisitors'
  | 'dayVisitors'
  | 'hourViews'
  | 'dayViews'
  | 'hourLandings'
  | 'dayLandings'
  | 'hourRefs'
  | 'dayRefs'
  | 'hourCamp'
  | 'dayCamp'
  | 'hourGeo'
  | 'dayGeo'
  | 'reach'
  | 'landing'
  | 'hourPathIndex'
  | 'dayPathIndex'
  | 'hourRefIndex'
  | 'dayRefIndex'
  | 'hourCampIndex'
  | 'dayCampIndex'
  | 'hourGeoIndex'
  | 'dayGeoIndex'
  | 'reachIndex'
  | 'hourOverflow'
  | 'dayOverflow';

/**
 * The keys one page view of `s` fills, less the mint keys a beacon opens —
 * those are tracked in {@link write}, which is how a beacon reaches the real
 * Redis here.
 */
function pageViewKeys(s: Scene): PageViewKeys {
  const keys: PageViewKeys = {
    hourVisitors: GROWTH_REDIS_KEYS.visitors.buildKey('h', s.hour),
    dayVisitors: GROWTH_REDIS_KEYS.visitors.buildKey('d', s.day),
    hourViews: GROWTH_REDIS_KEYS.views.buildKey('h', s.hour, s.path),
    dayViews: GROWTH_REDIS_KEYS.views.buildKey('d', s.day, s.path),
    hourLandings: GROWTH_REDIS_KEYS.landings.buildKey('h', s.hour, s.path),
    dayLandings: GROWTH_REDIS_KEYS.landings.buildKey('d', s.day, s.path),
    hourRefs: GROWTH_REDIS_KEYS.referrers.buildKey('h', s.hour, s.path, s.host),
    dayRefs: GROWTH_REDIS_KEYS.referrers.buildKey('d', s.day, s.path, s.host),
    hourCamp: GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', s.hour, s.campaign, s.path),
    dayCamp: GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', s.day, s.campaign, s.path),
    hourGeo: GROWTH_REDIS_KEYS.geo.buildKey('h', s.hour, HERE),
    dayGeo: GROWTH_REDIS_KEYS.geo.buildKey('d', s.day, HERE),
    reach: GROWTH_REDIS_KEYS.reach.buildKey(s.day, s.path, s.path),
    landing: GROWTH_REDIS_KEYS.landing.buildKey(s.day, s.visitor),
    hourPathIndex: GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'paths'),
    dayPathIndex: GROWTH_REDIS_KEYS.index.buildKey('d', s.day, 'paths'),
    hourRefIndex: GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'referrers'),
    dayRefIndex: GROWTH_REDIS_KEYS.index.buildKey('d', s.day, 'referrers'),
    hourCampIndex: GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'campaigns'),
    dayCampIndex: GROWTH_REDIS_KEYS.index.buildKey('d', s.day, 'campaigns'),
    hourGeoIndex: GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'geo'),
    dayGeoIndex: GROWTH_REDIS_KEYS.index.buildKey('d', s.day, 'geo'),
    reachIndex: GROWTH_REDIS_KEYS.index.buildKey('d', s.day, 'reach'),
    hourOverflow: GROWTH_REDIS_KEYS.overflow.buildKey('h', s.hour),
    dayOverflow: GROWTH_REDIS_KEYS.overflow.buildKey('d', s.day),
  };
  for (const key of Object.values(keys)) track(key);
  return keys;
}

/** The named keys of a scene, as a list a loop can assert over. */
function namedKeys(keys: PageViewKeys): readonly (readonly [string, string])[] {
  return Object.entries(keys);
}

/** The distinct-member count of a key this suite wrote. */
async function cardinality(key: string): Promise<number> {
  return redis.scard(key);
}

/** Whether a key this suite addressed exists at all. */
async function exists(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}

/** One beacon written, as the script answered for it. */
async function write(beacon: BeaconCount): Promise<BeaconWrite> {
  const result = await countBeacon(redis, beacon);
  const answered = result._unsafeUnwrap();
  track(GROWTH_REDIS_KEYS.mint.buildKey(growthDayBucket(beacon.at), beacon.mintId));
  track(GROWTH_REDIS_KEYS.mintCapped.buildKey(growthDayBucket(beacon.at), beacon.mintCappedId));
  return answered;
}

/** One beacon counted, with the overflow fields it latched. */
async function count(beacon: BeaconCount): Promise<readonly string[]> {
  const answered = await write(beacon);
  return answered.kind === 'counted' ? answered.overflowed : [];
}

/** The members of a set this suite wrote, ordered so an assertion can compare them. */
async function membersOf(key: string): Promise<string[]> {
  const members = await redis.smembers(key);
  return members.toSorted((a, b) => a.localeCompare(b));
}

/** `toSorted` needs an explicit collation comparator (sonarjs/no-alphabetical-sort). */
const byText = (a: string, b: string): number => a.localeCompare(b);

/** The visitor's claimed landing path for a day. */
async function landingPathOf(day: string, hash: string): Promise<string | null> {
  const stored = await redisGet(redis, GROWTH_REDIS_KEYS.landing, day, hash);
  return stored._unsafeUnwrap();
}

/** A bucket's overflow flags, as the rollup would read them. */
async function overflowFlagsOf(
  grain: 'h' | 'd',
  bucket: string
): Promise<Readonly<Record<string, number>>> {
  const flags = await redisHGetAll(redis, GROWTH_REDIS_KEYS.overflow, grain, bucket);
  return flags._unsafeUnwrap();
}

/** The dimension values one family opened in one bucket, as the rollup enumerates them. */
async function indexMembersOf(
  grain: 'h' | 'd',
  bucket: string,
  family: 'paths' | 'referrers' | 'geo' | 'reach' | 'events' | 'campaigns'
): Promise<readonly string[]> {
  const members = await redisSmembers(redis, GROWTH_REDIS_KEYS.index, grain, bucket, family);
  return members._unsafeUnwrap();
}

/** How many dimension values one family opened in one bucket. */
async function indexSizeOf(
  grain: 'h' | 'd',
  bucket: string,
  family: 'paths' | 'referrers' | 'geo' | 'reach' | 'events' | 'campaigns'
): Promise<number> {
  const size = await redisScard(redis, GROWTH_REDIS_KEYS.index, grain, bucket, family);
  return size._unsafeUnwrap();
}

/** Whether the address holds the day latch that makes its report fire once. */
async function latchedFor(day: string, mintCappedId: string): Promise<boolean> {
  const stored = await redisGet(redis, GROWTH_REDIS_KEYS.mintCapped, day, mintCappedId);
  return stored._unsafeUnwrap() === 1;
}

/**
 * Everything one beacon settles, as one value.
 *
 * A case that asserts the whole picture rather than the one figure it is about
 * is what makes a change to the REPORT visible as a change to a COUNT: the
 * admitted day total, the identities the address has minted, the day bucket's
 * overflow flags and the address's latch all move into the same assertion, so
 * none of them can shift unnoticed while a case watches the reply.
 */
interface BeaconPicture {
  readonly reply: BeaconWrite;
  readonly dayVisitors: number;
  readonly minted: number;
  readonly dayOverflow: Readonly<Record<string, number>>;
  readonly hourOverflow: Readonly<Record<string, number>>;
  readonly latched: boolean;
}

/** One beacon written, and the picture the store holds afterwards. */
async function picture(beacon: BeaconCount): Promise<BeaconPicture> {
  const reply = await write(beacon);
  const day = growthDayBucket(beacon.at);
  return {
    reply,
    dayVisitors: await cardinality(GROWTH_REDIS_KEYS.visitors.buildKey('d', day)),
    minted: await cardinality(GROWTH_REDIS_KEYS.mint.buildKey(day, beacon.mintId)),
    dayOverflow: await overflowFlagsOf('d', day),
    hourOverflow: await overflowFlagsOf('h', growthHourBucket(beacon.at)),
    latched: await latchedFor(day, beacon.mintCappedId),
  };
}

describe('countBeacon', () => {
  it('writes one member into every marginal a page view produces, at both grains', async () => {
    const s = scene(0);
    const keys = pageViewKeys(s);

    await count(pageView(s));

    const counted = namedKeys(keys).filter(
      ([name]) => !name.endsWith('Overflow') && name !== 'landing'
    );
    const cardinalities = await Promise.all(
      counted.map(async ([name, key]) => [name, await cardinality(key)] as const)
    );
    expect(cardinalities).toEqual(counted.map(([name]) => [name, 1]));
  });

  it('records the visitor hash itself as the member of each set', async () => {
    const s = scene(1);
    const keys = pageViewKeys(s);

    await count(pageView(s));

    expect(await membersOf(keys.hourViews)).toEqual([s.visitor]);
    expect(await membersOf(keys.dayVisitors)).toEqual([s.visitor]);
  });

  it('claims the visitor first path of the day and pairs reach against it', async () => {
    const s = scene(2);
    pageViewKeys(s);
    const second = `/p-${label()}`;
    const reachSecond = track(GROWTH_REDIS_KEYS.reach.buildKey(s.day, s.path, second));
    track(GROWTH_REDIS_KEYS.views.buildKey('h', s.hour, second));
    track(GROWTH_REDIS_KEYS.views.buildKey('d', s.day, second));
    track(GROWTH_REDIS_KEYS.landings.buildKey('h', s.hour, second));
    track(GROWTH_REDIS_KEYS.landings.buildKey('d', s.day, second));
    track(GROWTH_REDIS_KEYS.referrers.buildKey('h', s.hour, second, s.host));
    track(GROWTH_REDIS_KEYS.referrers.buildKey('d', s.day, second, s.host));
    track(GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', s.hour, s.campaign, second));
    track(GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', s.day, s.campaign, second));

    await count(pageView(s));
    await count(pageView(s, { path: second }));

    expect(await landingPathOf(s.day, s.visitor)).toBe(s.path);
    expect(await cardinality(reachSecond)).toBe(1);
    // The second page is not a landing: the visitor was already seen today.
    expect(await cardinality(GROWTH_REDIS_KEYS.landings.buildKey('d', s.day, second))).toBe(0);
  });

  // Every count is a set membership, which is exactly what makes the route's
  // idempotency exemption literally true rather than merely claimed.
  it('changes no cardinality when an identical beacon is replayed', async () => {
    const s = scene(3);
    const keys = pageViewKeys(s);

    await count(pageView(s));
    await count(pageView(s));
    await count(pageView(s));

    expect(await cardinality(keys.hourViews)).toBe(1);
    expect(await cardinality(keys.dayViews)).toBe(1);
    expect(await cardinality(keys.hourVisitors)).toBe(1);
    expect(await cardinality(keys.reach)).toBe(1);
    expect(await cardinality(keys.hourPathIndex)).toBe(1);
  });

  it('never lets a path landings exceed its views', async () => {
    const s = scene(4);
    const keys = pageViewKeys(s);
    const returning = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, returning));
    track(GROWTH_REDIS_KEYS.reach.buildKey(s.day, s.path, s.path));

    await count(pageView(s));
    await count(pageView(s, { visitor: returning }));
    // The same visitor again: still one landing.
    await count(pageView(s, { visitor: returning }));

    expect(await cardinality(keys.dayViews)).toBe(2);
    expect(await cardinality(keys.dayLandings)).toBe(2);
    expect(await cardinality(keys.dayLandings)).toBeLessThanOrEqual(
      await cardinality(keys.dayViews)
    );
  });

  it('writes the event set for a named event and no page-view set', async () => {
    const s = scene(5);
    const eventName = `link:${s.path}`;
    const eventKey = track(
      GROWTH_REDIS_KEYS.events.buildKey(s.hour, s.campaign, eventName, s.path)
    );
    const eventIndex = track(GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'events'));
    const hourViews = track(GROWTH_REDIS_KEYS.views.buildKey('h', s.hour, s.path));
    const hourVisitors = track(GROWTH_REDIS_KEYS.visitors.buildKey('h', s.hour));
    track(GROWTH_REDIS_KEYS.visitors.buildKey('d', s.day));

    await count(pageView(s, { kind: 'event', eventName, referrerHost: undefined }));

    expect(await cardinality(eventKey)).toBe(1);
    expect(await cardinality(hourVisitors)).toBe(1);
    expect(await cardinality(hourViews)).toBe(0);
    // The index member carries the event name whole, colon included.
    expect(await membersOf(eventIndex)).toEqual([
      encodeGrowthIndexMember([s.campaign, eventName, s.path]),
    ]);
  });

  // The campaign-free count cannot be recovered by adding the campaign-keyed
  // sets: they are cardinalities, and one person reaching the product under two
  // tags is one member here and one member of each of them.
  it('counts one product-entry clicker once across two campaigns', async () => {
    const s = scene(25);
    const entryName = productEntryName();
    const other = `c-${label()}`;
    const entryKey = track(GROWTH_REDIS_KEYS.productEntry.buildKey(s.hour));
    const underFirst = track(
      GROWTH_REDIS_KEYS.events.buildKey(s.hour, s.campaign, entryName, s.path)
    );
    const underOther = track(GROWTH_REDIS_KEYS.events.buildKey(s.hour, other, entryName, s.path));
    track(GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'events'));
    track(GROWTH_REDIS_KEYS.visitors.buildKey('h', s.hour));
    track(GROWTH_REDIS_KEYS.visitors.buildKey('d', s.day));

    await count(entryClick(s));
    await count(entryClick(s, { campaign: other }));

    expect(await cardinality(entryKey)).toBe(1);
    expect((await cardinality(underFirst)) + (await cardinality(underOther))).toBe(2);
  });

  it('leaves the product-entry set absent for a page view', async () => {
    const s = scene(26);
    pageViewKeys(s);
    const entryKey = track(GROWTH_REDIS_KEYS.productEntry.buildKey(s.hour));

    await count(pageView(s));

    expect(await exists(entryKey)).toBe(false);
  });

  it('leaves the product-entry set absent for an event that is not an entry', async () => {
    const s = scene(27);
    const elsewhere = `link:${s.path}`;
    const entryKey = track(GROWTH_REDIS_KEYS.productEntry.buildKey(s.hour));
    track(GROWTH_REDIS_KEYS.events.buildKey(s.hour, s.campaign, elsewhere, s.path));
    track(GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'events'));
    track(GROWTH_REDIS_KEYS.visitors.buildKey('h', s.hour));
    track(GROWTH_REDIS_KEYS.visitors.buildKey('d', s.day));

    await count(entryClick(s, { eventName: elsewhere }));

    expect(await exists(entryKey)).toBe(false);
  });

  it('refuses a member past the set ceiling and latches the overflow flag once', async () => {
    const s = scene(6);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, set: 1 };
    const later = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, later));

    const first = await count(pageView(s, { ceilings }));
    const second = await count(pageView(s, { visitor: later, ceilings }));
    const third = await count(pageView(s, { visitor: visitor(), ceilings }));

    expect(first).toEqual([]);
    expect(await cardinality(keys.hourViews)).toBe(1);
    expect(second).toContain(`h:${GROWTH_REDIS_KEYS.views.setName(s.path)}`);
    // The flag is the latch: the third refusal reports nothing new.
    expect(third).toEqual([]);
    expect(await overflowFlagsOf('h', s.hour)).toEqual(
      expect.objectContaining({ [GROWTH_REDIS_KEYS.views.setName(s.path)]: 1 })
    );
  });

  // Several sets refuse on one beacon, so the reply carries several names —
  // and a set name contains `:` and `/`, which is why it is joined on a
  // separator no name can contain rather than on either of those.
  it('reports every set that overflowed on one beacon, each name whole', async () => {
    const s = scene(13);
    pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, set: 1 };
    const later = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, later));

    await count(pageView(s, { ceilings }));
    const overflowed = await count(pageView(s, { visitor: later, ceilings }));

    expect(overflowed).toEqual(
      expect.arrayContaining([
        `h:${GROWTH_REDIS_KEYS.views.setName(s.path)}`,
        `d:${GROWTH_REDIS_KEYS.views.setName(s.path)}`,
        `h:${GROWTH_REDIS_KEYS.referrers.setName(s.path, s.host)}`,
        `h:${GROWTH_REDIS_KEYS.campaignPaths.setName(s.campaign, s.path)}`,
        `h:${GROWTH_REDIS_KEYS.geo.setName(HERE)}`,
      ])
    );
    // One flag per set per BUCKET: the same set filling at both grains is two
    // flags, and each entry names which grain it meant.
    expect(new Set(overflowed).size).toBe(overflowed.length);
  });

  it('folds a new referrer host into the catch-all past the index ceiling', async () => {
    const s = scene(7);
    pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, index: { paths: 500, referrers: 1 } };
    const secondHost = `h${label()}.example.com`;
    const foldedKey = track(GROWTH_REDIS_KEYS.referrers.buildKey('h', s.hour, s.path, 'other'));
    const naturalSecond = track(
      GROWTH_REDIS_KEYS.referrers.buildKey('h', s.hour, s.path, secondHost)
    );
    const refIndex = GROWTH_REDIS_KEYS.index.buildKey('h', s.hour, 'referrers');

    await count(pageView(s, { ceilings }));
    await count(pageView(s, { visitor: visitor(), referrerHost: secondHost, ceilings }));

    expect(await cardinality(naturalSecond)).toBe(0);
    expect(await cardinality(foldedKey)).toBe(1);
    expect(await membersOf(refIndex)).toEqual(
      [
        encodeGrowthIndexMember([s.path, s.host]),
        encodeGrowthIndexMember([s.path, 'other']),
      ].toSorted(byText)
    );
  });

  it('keeps a host already in the index counting under its own name at the ceiling', async () => {
    const s = scene(8);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, index: { paths: 500, referrers: 1 } };

    await count(pageView(s, { ceilings }));
    await count(pageView(s, { visitor: visitor(), ceilings }));

    expect(await cardinality(keys.hourRefs)).toBe(2);
  });

  it('answers the index members the rollup enumerates, each decodable whole', async () => {
    const s = scene(9);
    const keys = pageViewKeys(s);

    await count(pageView(s));

    expect(await indexMembersOf('h', s.hour, 'referrers')).toEqual([
      encodeGrowthIndexMember([s.path, s.host]),
    ]);
    expect(await indexMembersOf('d', s.day, 'geo')).toEqual([
      encodeGrowthIndexMember(['US', 'CA', 'desktop']),
    ]);
    expect(await indexSizeOf('d', s.day, 'reach')).toBe(1);
    expect(keys.reachIndex.endsWith('idx:reach')).toBe(true);
  });

  it('writes the campaign marginal under the tag the caller resolved', async () => {
    const s = scene(10);
    const keys = pageViewKeys(s);

    await count(pageView(s));

    expect(await cardinality(keys.hourCamp)).toBe(1);
    expect(await cardinality(keys.dayCamp)).toBe(1);
  });

  it('writes no referrer set when the beacon carried no referrer', async () => {
    const s = scene(11);
    const keys = pageViewKeys(s);

    await count(pageView(s, { referrerHost: undefined }));

    expect(await cardinality(keys.hourRefs)).toBe(0);
    expect(await cardinality(keys.hourRefIndex)).toBe(0);
    expect(await cardinality(keys.hourViews)).toBe(1);
  });

  // The identity is a hash over the address AND the user agent, and the user
  // agent is the sender's to vary — so this ceiling is what stands between one
  // address and a day's whole visitor count.
  it('drops a beacon whose address has minted its day of identities', async () => {
    const s = scene(18);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, mint: 1 };
    const later = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, later));

    await write(pageView(s, { ceilings }));
    const capped = await write(pageView(s, { visitor: later, ceilings }));

    expect(capped.kind).toBe('capped');
    expect(await cardinality(keys.dayVisitors)).toBe(1);
    expect(await cardinality(keys.dayViews)).toBe(1);
    expect(await landingPathOf(s.day, later)).toBeNull();
  });

  // A cap on identities must not be a cap on page views: the address behind a
  // household keeps counting for everyone it already minted.
  it('keeps counting an identity the address minted before the ceiling', async () => {
    const s = scene(15);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, mint: 1 };
    const second = `/p-${label()}`;
    const secondViews = track(GROWTH_REDIS_KEYS.views.buildKey('d', s.day, second));
    track(GROWTH_REDIS_KEYS.views.buildKey('h', s.hour, second));
    track(GROWTH_REDIS_KEYS.landings.buildKey('h', s.hour, second));
    track(GROWTH_REDIS_KEYS.landings.buildKey('d', s.day, second));
    track(GROWTH_REDIS_KEYS.referrers.buildKey('h', s.hour, second, s.host));
    track(GROWTH_REDIS_KEYS.referrers.buildKey('d', s.day, second, s.host));
    track(GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', s.hour, s.campaign, second));
    track(GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', s.day, s.campaign, second));
    track(GROWTH_REDIS_KEYS.reach.buildKey(s.day, s.path, second));

    await write(pageView(s, { ceilings }));
    const again = await write(pageView(s, { path: second, ceilings }));

    expect(again.kind).toBe('counted');
    expect(await cardinality(secondViews)).toBe(1);
    expect(await cardinality(keys.dayVisitors)).toBe(1);
  });

  // A Worker holds no memory between requests, so the store is the only thing
  // that can say a drop was already reported — without the latch the report
  // fires for every beacon the throttle admits.
  //
  // The address here is over its budget with no latch behind it, which is what
  // a ceiling lowered by a deploy can leave: the adds that built this set ran
  // under a higher ceiling that none of them reached, so the refusal is the
  // first thing that can report this address.
  it('reports one address drop once for the day', async () => {
    const s = scene(16);
    pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, mint: 1 };
    const minted = track(GROWTH_REDIS_KEYS.mint.buildKey(s.day, s.address.mintId));
    await redis.sadd(minted, visitor(), visitor());

    const first = await write(pageView(s, { visitor: visitor(), ceilings }));
    const second = await write(pageView(s, { visitor: visitor(), ceilings }));

    expect(first).toEqual({ kind: 'capped', firstToday: true });
    expect(second).toEqual({ kind: 'capped', firstToday: false });
  });

  // An address that has filled its budget has behaved like an inflater whether
  // or not one more identity arrived behind it — and the beacon that FILLS the
  // budget is ADMITTED, so a report raised only on the refusal past it stays
  // silent for a sender sized at exactly the budget.
  it('reports the address on the beacon that fills its daily identity budget', async () => {
    const s = scene(20);
    pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, mint: 2 };
    const fills = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, fills));

    await write(pageView(s, { ceilings }));
    const atBudget = await picture(pageView(s, { visitor: fills, ceilings }));

    expect(atBudget).toEqual({
      reply: { kind: 'counted', overflowed: [], mintFilled: true },
      dayVisitors: 2,
      minted: 2,
      dayOverflow: {},
      hourOverflow: {},
      latched: true,
    });
  });

  // The beacon that filled the budget wrote the latch, so the refusal past it
  // finds the key already there: reaching the budget and exceeding it are one
  // report rather than two.
  it('raises no second report when the address exceeds the budget it filled', async () => {
    const s = scene(21);
    pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, mint: 2 };
    const fills = visitor();
    track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, fills));

    await write(pageView(s, { ceilings }));
    await write(pageView(s, { visitor: fills, ceilings }));
    const past = await picture(pageView(s, { visitor: visitor(), ceilings }));

    expect(past).toEqual({
      reply: { kind: 'capped', firstToday: false },
      dayVisitors: 2,
      minted: 2,
      dayOverflow: {},
      hourOverflow: {},
      latched: true,
    });
  });

  // The sender a refusal-wired report cannot see: every address sized at
  // exactly its own budget, and exactly enough addresses to fill the day's
  // visitor set. Nothing is refused, so neither bucket's overflow hash carries
  // a flag, and the day's whole headline number belongs to this sender.
  it('reports every address of a sender sized at exactly both ceilings', async () => {
    const s = scene(22);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, set: 4, mint: 2 };
    const addresses = [s.address, address()];
    const filled: boolean[] = [];

    for (const ids of addresses) {
      for (const hash of [visitor(), visitor()]) {
        track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, hash));
        const reply = await write(pageView(s, { visitor: hash, ...ids, ceilings }));
        filled.push(reply.kind === 'counted' && reply.mintFilled);
      }
    }

    expect({
      filled,
      dayVisitors: await cardinality(keys.dayVisitors),
      dayOverflow: await overflowFlagsOf('d', s.day),
      hourOverflow: await overflowFlagsOf('h', s.hour),
      latched: await Promise.all(addresses.map((a) => latchedFor(s.day, a.mintCappedId))),
    }).toEqual({
      filled: [false, true, false, true],
      dayVisitors: 4,
      dayOverflow: {},
      hourOverflow: {},
      latched: [true, true],
    });
  });

  // A marker is written only where a budget FILLS or a member is refused, so a
  // sender shaped to do neither leaves nothing behind: one identity short of
  // each address's ceiling and one visitor short of the day's, every beacon is
  // counted, no address latches, and neither bucket's overflow hash is touched.
  // The boundary bites both ways — the same shape at exactly the ceilings
  // reports every address.
  it('leaves no marker for a sender sized one short of both ceilings', async () => {
    const s = scene(24);
    const keys = pageViewKeys(s);
    const ceilings: GrowthCeilings = { ...CEILINGS, set: 5, mint: 3 };
    const addresses = [s.address, address()];
    const filled: boolean[] = [];

    for (const ids of addresses) {
      for (const hash of [visitor(), visitor()]) {
        track(GROWTH_REDIS_KEYS.landing.buildKey(s.day, hash));
        const reply = await write(pageView(s, { visitor: hash, ...ids, ceilings }));
        filled.push(reply.kind === 'counted' && reply.mintFilled);
      }
    }

    expect({
      filled,
      dayVisitors: await cardinality(keys.dayVisitors),
      minted: await Promise.all(
        addresses.map((a) => cardinality(GROWTH_REDIS_KEYS.mint.buildKey(s.day, a.mintId)))
      ),
      dayOverflow: await overflowFlagsOf('d', s.day),
      hourOverflow: await overflowFlagsOf('h', s.hour),
      latched: await Promise.all(addresses.map((a) => latchedFor(s.day, a.mintCappedId))),
    }).toEqual({
      filled: [false, false, false, false],
      dayVisitors: 4,
      minted: [2, 2],
      dayOverflow: {},
      hourOverflow: {},
      latched: [false, false],
    });
  });

  it('records the identity against the address that minted it', async () => {
    const s = scene(17);
    pageViewKeys(s);
    const minted = track(GROWTH_REDIS_KEYS.mint.buildKey(s.day, s.address.mintId));

    await write(pageView(s));

    expect(await membersOf(minted)).toEqual([s.visitor]);
  });

  // A counter outage must never break a marketing page, so the route answers
  // the same either way — but it has to learn that nothing was counted.
  it('surfaces an unavailable error when redis cannot be reached', async () => {
    const s = scene(12);
    const result = await countBeacon(unreachableRedis, pageView(s));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('the day a case counts on', () => {
  // A day two cases share reads as harmless for exactly as long as one of them
  // happens to write nothing to the day-global keys both address, which is a
  // property of the two cases rather than one anything holds them to.
  it('refuses a day another case already took', () => {
    const day = 19;
    dayApart(day);
    expect(() => dayApart(day)).toThrow();
  });
});

/**
 * Every status the reply's first field can carry, paired with what the counting
 * module must read it as.
 *
 * The set is {@link BEACON_STATUS}. The cases below hold this list and that
 * declaration to each other, so the two cannot differ in either direction, and
 * they hold the declaration to the script, so a status nothing returns fails
 * too. The script interpolates these same values, which is what stops the two
 * sides of the reply spelling a status differently; what these add is that
 * neither side can omit one.
 */
const REPLY_READINGS: readonly (readonly [string, BeaconWrite])[] = [
  [BEACON_STATUS.counted, { kind: 'counted', overflowed: [], mintFilled: false }],
  [BEACON_STATUS.countedFull, { kind: 'counted', overflowed: [], mintFilled: true }],
  [BEACON_STATUS.capped, { kind: 'capped', firstToday: false }],
  [BEACON_STATUS.cappedFirst, { kind: 'capped', firstToday: true }],
];

/**
 * A client whose script answers one fixed reply and whose landing read answers
 * nothing. It is asserted into the client type because the module takes the
 * pipeline's whole Redis client and these cases exercise the two calls it
 * makes; a real client cannot be made to answer a chosen status.
 */
function replying(reply: string): Redis {
  return {
    get: () => Promise.resolve(null),
    createScript: () => ({ exec: () => Promise.resolve(reply) }),
  } as unknown as Redis;
}

describe('the beacon reply', () => {
  it('reads every status the declaration carries', () => {
    expect(REPLY_READINGS.map(([status]) => status).toSorted(byText)).toEqual(
      Object.values(BEACON_STATUS).toSorted(byText)
    );
  });

  it('returns each declared status from the script itself', () => {
    const returned = Object.values(BEACON_STATUS).filter((status) =>
      BEACON_SCRIPT.includes(`'${status}'`)
    );
    expect(returned).toEqual(Object.values(BEACON_STATUS));
  });

  it('reads each status into the outcome it stands for', async () => {
    const s = scene(23);
    const read: BeaconWrite[] = [];

    for (const [status] of REPLY_READINGS) {
      const answered = await countBeacon(replying(status), pageView(s));
      read.push(answered._unsafeUnwrap());
    }

    expect(read).toEqual(REPLY_READINGS.map(([, outcome]) => outcome));
  });
});

describe('the beacon wire', () => {
  // The strides live in one declaration the script interpolates and the builder
  // reads. This pins that the arrays the builder produces have the arity that
  // declaration promises, so a stride change that reached only one side would
  // fail here rather than in a mis-addressed Redis key.
  it('builds arrays at the arity the declared strides promise', async () => {
    const s = scene(14);
    const keys = pageViewKeys(s);
    const seen: { keys: number; args: number } = { keys: 0, args: 0 };
    const recording = {
      get: () => Promise.resolve(null),
      createScript: () => ({
        exec: (evalKeys: string[], evalArgs: string[]) => {
          seen.keys = evalKeys.length;
          seen.args = evalArgs.length;
          // The script's own reply for a beacon that counted and latched
          // nothing. A reply that does not lead with the counted status reads
          // as a drop, so a stub inventing one drives this case through a reply
          // the wire it pins cannot carry.
          return Promise.resolve(BEACON_STATUS.counted);
        },
      }),
    } as unknown as Redis;

    const counted = await countBeacon(recording, pageView(s));

    expect(counted._unsafeUnwrap()).toEqual({ kind: 'counted', overflowed: [], mintFilled: false });
    const ops = (seen.keys - BEACON_WIRE.fixedKeys) / BEACON_WIRE.keysPerOp;
    expect(Number.isInteger(ops)).toBe(true);
    expect(seen.args).toBe(BEACON_WIRE.fixedArgs + ops * BEACON_WIRE.argsPerOp);
    expect(keys.hourVisitors.length).toBeGreaterThan(0);
  });
});
