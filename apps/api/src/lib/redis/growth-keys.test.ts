import { describe, expect, it } from 'vitest';
import { growthDayBucket, growthHourBucket } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  decodeGrowthIndexMember,
  encodeGrowthIndexMember,
} from './growth-keys.js';

/** The reference day and an hour inside it, as the two grains label them. */
const DAY = growthDayBucket(new Date(TEST_DAY_START));
const HOUR = growthHourBucket(new Date(TEST_DAY_START + 14 * HOUR_MS));

describe('encodeGrowthIndexMember', () => {
  it('joins the dimension values on a separator no growth value admits', () => {
    expect(encodeGrowthIndexMember(['/welcome', 'example.com'])).toBe('/welcome\u001Fexample.com');
  });

  it('encodes an empty dimension value as an empty field', () => {
    expect(encodeGrowthIndexMember(['', '', 'desktop'])).toBe('\u001F\u001Fdesktop');
  });

  it('refuses a value carrying the separator', () => {
    expect(() => encodeGrowthIndexMember(['a\u001Fb'])).toThrow(/separator/u);
  });
});

describe('decodeGrowthIndexMember', () => {
  // A colon-delimited key split on `:` tears `link:/signup` in half and
  // attributes its counts to a dimension nobody ever wrote.
  it('recovers a dimension value that itself contains a colon', () => {
    const encoded = encodeGrowthIndexMember(['spring-launch', 'link:/signup', '/welcome']);
    expect(decodeGrowthIndexMember(encoded, 3)).toEqual([
      'spring-launch',
      'link:/signup',
      '/welcome',
    ]);
  });

  it('recovers a value containing a slash, a dot and a hyphen', () => {
    const encoded = encodeGrowthIndexMember(['/blog/a-post', 'news.example-site.com']);
    expect(decodeGrowthIndexMember(encoded, 2)).toEqual(['/blog/a-post', 'news.example-site.com']);
  });

  it('recovers empty dimension values', () => {
    expect(decodeGrowthIndexMember(encodeGrowthIndexMember(['', '', 'other']), 3)).toEqual([
      '',
      '',
      'other',
    ]);
  });

  it('refuses a member whose field count is not the one expected', () => {
    expect(() => decodeGrowthIndexMember('a\u001Fb', 3)).toThrow(/3/u);
  });
});

describe('GROWTH_REDIS_KEYS', () => {
  /** A day-keyed address identity, in the shape the address-keyed sets admit. */
  const ADDRESS_ID = 'f'.repeat(64);

  /** One geography, so the key and the field below are built from one value. */
  const PLACE = { country: 'US', region: 'CA', device: 'mobile' } as const;

  const cases: readonly (readonly [string, string])[] = [
    ['visitors', GROWTH_REDIS_KEYS.visitors.buildKey('h', HOUR)],
    ['views', GROWTH_REDIS_KEYS.views.buildKey('d', DAY, '/welcome')],
    ['landings', GROWTH_REDIS_KEYS.landings.buildKey('h', HOUR, '/welcome')],
    ['referrers', GROWTH_REDIS_KEYS.referrers.buildKey('h', HOUR, '/welcome', 'example.com')],
    ['campaignPaths', GROWTH_REDIS_KEYS.campaignPaths.buildKey('d', DAY, 'spring', '/welcome')],
    [
      'geo',
      GROWTH_REDIS_KEYS.geo.buildKey('h', HOUR, {
        country: 'US',
        region: 'CA',
        device: 'mobile',
      }),
    ],
    ['events', GROWTH_REDIS_KEYS.events.buildKey(HOUR, 'spring', 'link:/signup', '/welcome')],
    ['productEntry', GROWTH_REDIS_KEYS.productEntry.buildKey(HOUR)],
    ['landing', GROWTH_REDIS_KEYS.landing.buildKey(DAY, 'abc')],
    ['reach', GROWTH_REDIS_KEYS.reach.buildKey(DAY, '/welcome', '/privacy')],
    ['started', GROWTH_REDIS_KEYS.started.buildKey(HOUR, 'spring')],
    ['startedDecoy', GROWTH_REDIS_KEYS.startedDecoy.buildKey(HOUR, 'spring')],
    ['mint', GROWTH_REDIS_KEYS.mint.buildKey(DAY, ADDRESS_ID)],
    ['mintCapped', GROWTH_REDIS_KEYS.mintCapped.buildKey(DAY, ADDRESS_ID)],
    ['index', GROWTH_REDIS_KEYS.index.buildKey('h', HOUR, 'referrers')],
    ['overflow', GROWTH_REDIS_KEYS.overflow.buildKey('h', HOUR)],
    ['activeCampaigns', GROWTH_REDIS_KEYS.activeCampaigns.buildKey()],
  ];

  it.each(cases)('builds %s under the growth namespace', (_name, key) => {
    expect(key.startsWith('growth:')).toBe(true);
  });

  it('builds a key per grain from the grain and its bucket', () => {
    expect(GROWTH_REDIS_KEYS.views.buildKey('h', HOUR, '/welcome')).toBe(
      `growth:h:${HOUR}:views:/welcome`
    );
    expect(GROWTH_REDIS_KEYS.views.buildKey('d', DAY, '/welcome')).toBe(
      `growth:d:${DAY}:views:/welcome`
    );
  });

  it('names the referrer set by path then host', () => {
    expect(GROWTH_REDIS_KEYS.referrers.buildKey('h', HOUR, '/welcome', 'example.com')).toBe(
      `growth:h:${HOUR}:refs:/welcome:example.com`
    );
  });

  it('keeps the event set on the hour grain alone', () => {
    expect(GROWTH_REDIS_KEYS.events.buildKey(HOUR, 'direct', 'scroll-50', '/welcome')).toBe(
      `growth:h:${HOUR}:events:direct:scroll-50:/welcome`
    );
  });

  // The family exists to answer how many people entered the product, full
  // stop, so a campaign in the key would make it a sixth campaign-keyed set
  // rather than the marginal across them.
  it('keys the product-entry family by the hour alone, naming no campaign', () => {
    expect(GROWTH_REDIS_KEYS.productEntry.buildKey(HOUR)).toBe(`growth:h:${HOUR}:product-entry`);
  });

  it('keeps the reach and landing families on the day grain alone', () => {
    expect(GROWTH_REDIS_KEYS.reach.buildKey(DAY, '/welcome', '/privacy')).toBe(
      `growth:d:${DAY}:reach:/welcome:/privacy`
    );
    expect(GROWTH_REDIS_KEYS.landing.buildKey(DAY, 'abc123')).toBe(
      `growth:d:${DAY}:landing:abc123`
    );
  });

  // The mint ceiling is per address per day, so the day is the bucket and the
  // address identity is what separates one minter from the next.
  it('keys the mint family by the day and the address identity', () => {
    expect(GROWTH_REDIS_KEYS.mint.buildKey(DAY, ADDRESS_ID)).toBe(
      `growth:d:${DAY}:mint:${ADDRESS_ID}`
    );
    expect(GROWTH_REDIS_KEYS.mintCapped.buildKey(DAY, ADDRESS_ID)).toBe(
      `growth:d:${DAY}:mint-capped:${ADDRESS_ID}`
    );
  });

  /**
   * Every family the registry gives a flag field, with one key and the field
   * built from the same dimension values. Written out because each family
   * takes its own arguments, and held whole by the membership case below: the
   * field IS the set's own name, so a family whose two builders disagree files
   * a flag the rollup then reads onto no row at all.
   */
  const flagged: readonly (readonly [string, string, string])[] = [
    [
      'visitors',
      GROWTH_REDIS_KEYS.visitors.buildKey('h', HOUR),
      GROWTH_REDIS_KEYS.visitors.setName(),
    ],
    [
      'views',
      GROWTH_REDIS_KEYS.views.buildKey('h', HOUR, '/welcome'),
      GROWTH_REDIS_KEYS.views.setName('/welcome'),
    ],
    [
      'landings',
      GROWTH_REDIS_KEYS.landings.buildKey('h', HOUR, '/welcome'),
      GROWTH_REDIS_KEYS.landings.setName('/welcome'),
    ],
    [
      'referrers',
      GROWTH_REDIS_KEYS.referrers.buildKey('h', HOUR, '/welcome', 'example.com'),
      GROWTH_REDIS_KEYS.referrers.setName('/welcome', 'example.com'),
    ],
    [
      'campaignPaths',
      GROWTH_REDIS_KEYS.campaignPaths.buildKey('h', HOUR, 'spring', '/welcome'),
      GROWTH_REDIS_KEYS.campaignPaths.setName('spring', '/welcome'),
    ],
    ['geo', GROWTH_REDIS_KEYS.geo.buildKey('h', HOUR, PLACE), GROWTH_REDIS_KEYS.geo.setName(PLACE)],
    [
      'events',
      GROWTH_REDIS_KEYS.events.buildKey(HOUR, 'spring', 'link:/signup', '/welcome'),
      GROWTH_REDIS_KEYS.events.setName('spring', 'link:/signup', '/welcome'),
    ],
    [
      'productEntry',
      GROWTH_REDIS_KEYS.productEntry.buildKey(HOUR),
      GROWTH_REDIS_KEYS.productEntry.setName(),
    ],
    [
      'reach',
      GROWTH_REDIS_KEYS.reach.buildKey(DAY, '/welcome', '/privacy'),
      GROWTH_REDIS_KEYS.reach.setName('/welcome', '/privacy'),
    ],
    [
      'started',
      GROWTH_REDIS_KEYS.started.buildKey(HOUR, 'spring'),
      GROWTH_REDIS_KEYS.started.setName('spring'),
    ],
    [
      'startedDecoy',
      GROWTH_REDIS_KEYS.startedDecoy.buildKey(HOUR, 'spring'),
      GROWTH_REDIS_KEYS.startedDecoy.setName('spring'),
    ],
  ];

  it('covers every family the registry gives a flag field', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);
    const declared = Object.entries(GROWTH_REDIS_KEYS)
      .filter(([, entry]) => 'setName' in entry)
      .map(([name]) => name);
    expect(flagged.map(([name]) => name).toSorted(byName)).toEqual(declared.toSorted(byName));
  });

  // The overflow field is the set's own name inside its bucket, so a flag and
  // the set it flags cannot drift apart.
  it.each(flagged)(
    'ends the %s key with the field its flag is filed under',
    (_name, key, field) => {
      expect(key.endsWith(field)).toBe(true);
    }
  );

  it('expires every bucketed family after the shared retention window', () => {
    expect(GROWTH_REDIS_KEYS.visitors.ttlSeconds).toBe(GROWTH_REDIS_TTL_SECONDS);
    expect(GROWTH_REDIS_KEYS.reach.ttlSeconds).toBe(GROWTH_REDIS_TTL_SECONDS);
    expect(GROWTH_REDIS_KEYS.mint.ttlSeconds).toBe(GROWTH_REDIS_TTL_SECONDS);
    expect(GROWTH_REDIS_KEYS.mintCapped.ttlSeconds).toBe(GROWTH_REDIS_TTL_SECONDS);
    expect(GROWTH_REDIS_TTL_SECONDS).toBe(36 * 60 * 60);
  });

  it('expires the active-campaign registry far sooner than the counters', () => {
    expect(GROWTH_REDIS_KEYS.activeCampaigns.ttlSeconds).toBeLessThan(GROWTH_REDIS_TTL_SECONDS);
  });
});
