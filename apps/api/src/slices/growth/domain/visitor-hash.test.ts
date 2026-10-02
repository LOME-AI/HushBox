import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { callerIpIdForAddress, growthDayBucket } from '../../../lib/redis/index.js';
import { dailyAddressId, visitorHash } from './visitor-hash.js';
import type { DailyAddressSet } from './visitor-hash.js';

const SECRET = 'a-growth-hash-secret-of-at-least-32-chars';
const OTHER_SECRET = 'a-different-growth-hash-secret-32-chars!!';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36';
/** The two day labels, derived from the shared reference instant rather than written out. */
const DAY = growthDayBucket(new Date(TEST_DAY_START));
const NEXT_DAY = growthDayBucket(new Date(TEST_DAY_START + DAY_MS));

describe('visitorHash', () => {
  it('answers 32 lowercase hex characters', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    ).toMatch(/^[\da-f]{32}$/u);
  });

  it('is the same for one visitor throughout a day', async () => {
    const first = await visitorHash({
      secret: SECRET,
      address: '203.0.113.7',
      userAgent: UA,
      day: DAY,
    });
    const second = await visitorHash({
      secret: SECRET,
      address: '203.0.113.7',
      userAgent: UA,
      day: DAY,
    });
    expect(first).toBe(second);
  });

  // Rotation at UTC midnight is what bounds how long any hash can be correlated.
  it('changes for the same visitor on the next day', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    ).not.toBe(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: NEXT_DAY })
    );
  });

  // Keyed rather than salted: without the key a precomputed table over IPv4 ×
  // common user agents is useless.
  it('changes under a different key', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    ).not.toBe(
      await visitorHash({ secret: OTHER_SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    );
  });

  it('distinguishes two addresses', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    ).not.toBe(
      await visitorHash({ secret: SECRET, address: '203.0.113.8', userAgent: UA, day: DAY })
    );
  });

  it('distinguishes two user agents', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY })
    ).not.toBe(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: 'curl/8', day: DAY })
    );
  });

  // The /64 is the standard delegation to one subscriber, so the host bits are
  // the visitor's to rotate and a hash over them would count one household as
  // a population the size of its address space. It bounds the address half
  // only: the user agent is the sender's to vary just as freely, and what
  // bounds THAT is the write script's per-address mint ceiling.
  it('collapses two addresses in one IPv6 /64 onto one visitor', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '2001:db8:1:2::1', userAgent: UA, day: DAY })
    ).toBe(
      await visitorHash({
        secret: SECRET,
        address: '2001:db8:1:2:ffff:ffff:ffff:ffff',
        userAgent: UA,
        day: DAY,
      })
    );
  });

  it('keeps two different IPv6 /64s apart', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '2001:db8:1:2::1', userAgent: UA, day: DAY })
    ).not.toBe(
      await visitorHash({ secret: SECRET, address: '2001:db8:1:3::1', userAgent: UA, day: DAY })
    );
  });

  it('gives an IPv4-mapped address the identity of the IPv4 address it is', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '::ffff:203.0.113.7', userAgent: UA, day: DAY })
    ).toBe(await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: UA, day: DAY }));
  });

  // The fields are separated by a byte no field can contain, so no pair of
  // (address, user agent) values can be rearranged into another pair's digest.
  it('does not let an address and a user agent trade characters', async () => {
    expect(
      await visitorHash({ secret: SECRET, address: '203.0.113.7', userAgent: 'ab', day: DAY })
    ).not.toBe(
      await visitorHash({ secret: SECRET, address: '203.0.113.7a', userAgent: 'b', day: DAY })
    );
  });
});

const ADDRESS_SETS: readonly DailyAddressSet[] = ['mint', 'mintCapped', 'started'];

describe('dailyAddressId', () => {
  it.each(ADDRESS_SETS)('answers 64 lowercase hex characters for the %s set', async (set) => {
    expect(await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set })).toMatch(
      /^[\da-f]{64}$/u
    );
  });

  it.each(ADDRESS_SETS)(
    'is the same for one address throughout a day in the %s set',
    async (set) => {
      expect(await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set })).toBe(
        await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set })
      );
    }
  );

  // The key names and members these sets carry live 36 hours, so one day's
  // identity must not be matchable to the next day's.
  it.each(ADDRESS_SETS)(
    'changes for the same address on the next day in the %s set',
    async (set) => {
      expect(
        await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set })
      ).not.toBe(
        await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: NEXT_DAY, set })
      );
    }
  );

  // A started member equal to a mint key's suffix would let a reader holding
  // no secret join a registration start to that address's visitor codes.
  it.each([
    ['mint', 'mintCapped'],
    ['mint', 'started'],
    ['mintCapped', 'started'],
  ] as const)('gives one address different %s and %s identities on one day', async (a, b) => {
    expect(
      await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set: a })
    ).not.toBe(await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set: b }));
  });

  // The unkeyed digest reverses by enumerating IPv4; a keyed one does not.
  it.each(ADDRESS_SETS)('is not the unkeyed caller-IP digest in the %s set', async (set) => {
    expect(
      await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set })
    ).not.toBe(await callerIpIdForAddress('203.0.113.7'));
  });

  it('changes under a different key', async () => {
    expect(
      await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set: 'mint' })
    ).not.toBe(
      await dailyAddressId({ secret: OTHER_SECRET, address: '203.0.113.7', day: DAY, set: 'mint' })
    );
  });

  it('is not any visitor hash of the same address and day', async () => {
    const visitor = await visitorHash({
      secret: SECRET,
      address: '203.0.113.7',
      userAgent: UA,
      day: DAY,
    });
    const id = await dailyAddressId({
      secret: SECRET,
      address: '203.0.113.7',
      day: DAY,
      set: 'mint',
    });
    expect(id.startsWith(visitor)).toBe(false);
  });

  it('distinguishes two addresses', async () => {
    expect(
      await dailyAddressId({ secret: SECRET, address: '203.0.113.7', day: DAY, set: 'mint' })
    ).not.toBe(
      await dailyAddressId({ secret: SECRET, address: '203.0.113.8', day: DAY, set: 'mint' })
    );
  });

  // The ceiling must bound the population the rate limiters bound, so the
  // address is reduced the one shared way before it is keyed.
  it('collapses two addresses in one IPv6 /64 onto one identity', async () => {
    expect(
      await dailyAddressId({ secret: SECRET, address: '2001:db8:1:2::1', day: DAY, set: 'mint' })
    ).toBe(
      await dailyAddressId({
        secret: SECRET,
        address: '2001:db8:1:2:ffff:ffff:ffff:ffff',
        day: DAY,
        set: 'mint',
      })
    );
  });
});
