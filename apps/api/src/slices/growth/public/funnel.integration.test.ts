import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  callerIpIdForAddress,
  growthDayBucket,
  growthHourBucket,
  redisHGetAll,
} from '../../../lib/redis/index.js';
import { growthTestDays } from '../../../test-support/growth-test-days.js';
import { countRegistrationStartedUnderCeiling } from '../domain/count-registration-started.js';
import { dailyAddressId } from '../domain/visitor-hash.js';
import { countRegistrationStarted } from './funnel.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for growth funnel integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const written: string[] = [];

afterAll(async () => {
  if (written.length > 0) await redis.del(...written);
});

/** A campaign tag no other test in this run counts under. */
function tag(): string {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

const SECRET = 'a-growth-hash-secret-of-at-least-32-chars';

/** A day-keyed address identity of the shape the key registry admits: 64 hex characters. */
function addressId(): string {
  return Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(
    ''
  );
}

/**
 * Where this file's cases sit: a lane of its own, measured from the day the run
 * is happening on. The bucket's overflow hash is addressed by its bucket and
 * nothing else, and every growth test file in a run shares one Redis keyspace,
 * so a day two of them both name has each reading the other's flags. A lane
 * makes that impossible; the draw this replaces only made it unlikely.
 */
const DAYS = growthTestDays('funnel', new Date());

/** The day indices cases in this file have already claimed. */
const daysTaken = new Set<number>();

/**
 * A whole UTC day to itself per case, named by the hour its counts land in.
 * Same reason as {@link DAYS} one level down: two cases sharing a day would
 * read each other's overflow flags. A day already claimed is refused here,
 * because a shared day stays invisible for as long as one of the two cases
 * happens to latch nothing.
 */
function instantApart(index: number): Date {
  if (daysTaken.has(index)) {
    throw new Error(`another case in this file already counts on ${String(index)}`);
  }
  daysTaken.add(index);
  return DAYS.clean(index);
}

function hourApart(index: number): string {
  return growthHourBucket(instantApart(index));
}

/** An address no other case in this file presents. */
function address(): string {
  return `2001:db8:${crypto.randomUUID().slice(0, 4)}:${crypto.randomUUID().slice(0, 4)}::1`;
}

function startedKey(hour: string, campaign: string): string {
  const key = GROWTH_REDIS_KEYS.started.buildKey(hour, campaign);
  written.push(key);
  return key;
}

function decoyKey(hour: string, campaign: string): string {
  const key = GROWTH_REDIS_KEYS.startedDecoy.buildKey(hour, campaign);
  written.push(key);
  return key;
}

/** The hour bucket's overflow flags, as the rollup reads them back. */
async function overflowFlagsOf(hour: string): Promise<Readonly<Record<string, number>>> {
  const flags = await redisHGetAll(redis, GROWTH_REDIS_KEYS.overflow, 'h', hour);
  return flags._unsafeUnwrap();
}

function overflowKey(hour: string): string {
  const key = GROWTH_REDIS_KEYS.overflow.buildKey('h', hour);
  written.push(key);
  return key;
}

describe('countRegistrationStarted', () => {
  it('counts one member for a handshake replayed from one address', async () => {
    const at = instantApart(1);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);
    const from = address();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const counted = await countRegistrationStarted(redis, {
        secret: SECRET,
        address: from,
        at,
        campaign,
        decoy: false,
      });
      expect(counted.isOk()).toBe(true);
    }

    expect(await redis.scard(key)).toBe(1);
  });

  it('counts two members for two addresses under one campaign', async () => {
    const at = instantApart(2);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);

    for (const from of [address(), address()]) {
      const counted = await countRegistrationStarted(redis, {
        secret: SECRET,
        address: from,
        at,
        campaign,
        decoy: false,
      });
      counted._unsafeUnwrap();
    }

    expect(await redis.scard(key)).toBe(2);
  });

  it('writes a decoy start to the shadow set and leaves the counted set empty', async () => {
    const at = instantApart(3);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);
    const shadow = decoyKey(growthHourBucket(at), campaign);

    const counted = await countRegistrationStarted(redis, {
      secret: SECRET,
      address: address(),
      at,
      campaign,
      decoy: true,
    });

    expect(counted.isOk()).toBe(true);
    expect(await redis.scard(shadow)).toBe(1);
    expect(await redis.scard(key)).toBe(0);
  });

  it('gives the set the growth retention window so an unrolled hour survives', async () => {
    const at = instantApart(4);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);

    const counted = await countRegistrationStarted(redis, {
      secret: SECRET,
      address: address(),
      at,
      campaign,
      decoy: false,
    });
    counted._unsafeUnwrap();

    expect(await redis.ttl(key)).toBeGreaterThan(GROWTH_REDIS_TTL_SECONDS - 60);
  });

  it('answers no latch for a start the shared ceiling admits', async () => {
    const at = instantApart(10);
    const campaign = tag();
    startedKey(growthHourBucket(at), campaign);
    overflowKey(growthHourBucket(at));

    const counted = await countRegistrationStarted(redis, {
      secret: SECRET,
      address: address(),
      at,
      campaign,
      decoy: false,
    });

    expect(counted._unsafeUnwrap()).toBe(false);
  });

  // The member is keyed under the day and under a label of its own, so no
  // reader without the secret can join it to an address or to a mint key.
  it('files the start under the address’s day-keyed started identity', async () => {
    const at = instantApart(14);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);
    const from = address();

    const counted = await countRegistrationStarted(redis, {
      secret: SECRET,
      address: from,
      at,
      campaign,
      decoy: false,
    });
    counted._unsafeUnwrap();

    expect(await redis.smembers(key)).toEqual([
      await dailyAddressId({
        secret: SECRET,
        address: from,
        day: growthDayBucket(at),
        set: 'started',
      }),
    ]);
  });

  // An unkeyed digest of an address reverses by enumerating IPv4.
  it('never files the unkeyed address digest', async () => {
    const at = instantApart(15);
    const campaign = tag();
    const key = startedKey(growthHourBucket(at), campaign);
    const from = '198.51.100.23';

    const counted = await countRegistrationStarted(redis, {
      secret: SECRET,
      address: from,
      at,
      campaign,
      decoy: false,
    });
    counted._unsafeUnwrap();

    expect(await redis.scard(key)).toBe(1);
    expect(await redis.sismember(key, await callerIpIdForAddress(from))).toBe(0);
  });

  it('files one address under a different member on the next day', async () => {
    // Consecutive indices of a lane are consecutive UTC days.
    const first = instantApart(16);
    const next = instantApart(17);
    const campaign = tag();
    const from = address();
    const keys = [first, next].map((at) => startedKey(growthHourBucket(at), campaign));

    for (const at of [first, next]) {
      const counted = await countRegistrationStarted(redis, {
        secret: SECRET,
        address: from,
        at,
        campaign,
        decoy: false,
      });
      counted._unsafeUnwrap();
    }

    const members = await Promise.all(keys.map(async (key) => redis.smembers(key)));
    expect(members[0]).toHaveLength(1);
    expect(members[1]).toHaveLength(1);
    expect(members[0]).not.toEqual(members[1]);
  });
});

describe('countRegistrationStartedUnderCeiling', () => {
  /**
   * Counts one address and answers whether this call was the one that latched
   * the bucket's flag, failing the case rather than the assertion if the write
   * did not land.
   */
  async function count(start: {
    readonly hour: string;
    readonly campaign: string;
    readonly addressId: string;
    readonly decoy: boolean;
    readonly ceiling: number;
  }): Promise<boolean> {
    const counted = await countRegistrationStartedUnderCeiling(
      redis,
      {
        hour: start.hour,
        campaign: start.campaign,
        addressId: start.addressId,
        decoy: start.decoy,
      },
      start.ceiling
    );
    return counted._unsafeUnwrap();
  }

  /** One ordering both sides of a member comparison are put in. */
  function byName(left: string, right: string): number {
    return left.localeCompare(right);
  }

  it('flags nothing while the set is filling to its ceiling', async () => {
    const hour = hourApart(5);
    const campaign = tag();
    const key = startedKey(hour, campaign);
    overflowKey(hour);

    for (const id of [addressId(), addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }

    expect(await redis.scard(key)).toBe(2);
    // The flag is the refusal, never the ceiling being reached: a set holding
    // exactly its ceiling turned nobody away, so its count is exact.
    expect(await overflowFlagsOf(hour)).toEqual({});
  });

  it('refuses an address past the ceiling and keeps the count at it', async () => {
    const hour = hourApart(6);
    const campaign = tag();
    const key = startedKey(hour, campaign);
    overflowKey(hour);
    const admitted = [addressId(), addressId()];

    for (const id of admitted) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }
    await count({ hour, campaign, addressId: addressId(), decoy: false, ceiling: 2 });

    const members = await redis.smembers(key);
    expect(members.toSorted(byName)).toEqual(admitted.toSorted(byName));
  });

  it('files the refusal under the set’s own name on the hour bucket', async () => {
    const hour = hourApart(7);
    const campaign = tag();
    startedKey(hour, campaign);
    overflowKey(hour);

    for (const id of [addressId(), addressId(), addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }

    expect(await overflowFlagsOf(hour)).toEqual({
      [GROWTH_REDIS_KEYS.started.setName(campaign)]: 1,
    });
  });

  it('counts an address the set already holds once the set is at its ceiling', async () => {
    const hour = hourApart(8);
    const campaign = tag();
    const key = startedKey(hour, campaign);
    overflowKey(hour);
    const returning = addressId();

    for (const id of [returning, addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }
    await count({ hour, campaign, addressId: returning, decoy: false, ceiling: 2 });

    expect(await redis.scard(key)).toBe(2);
    // A membership test ahead of the cardinality test is what keeps a returning
    // address from raising a flag the count it joins was never cut off by.
    expect(await overflowFlagsOf(hour)).toEqual({});
  });

  it('files a decoy refusal under the shadow set’s own name', async () => {
    const hour = hourApart(9);
    const campaign = tag();
    decoyKey(hour, campaign);
    overflowKey(hour);

    for (const id of [addressId(), addressId(), addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: true, ceiling: 2 });
    }

    expect(await overflowFlagsOf(hour)).toEqual({
      [GROWTH_REDIS_KEYS.startedDecoy.setName(campaign)]: 1,
    });
  });

  it('reports no latch while the set is filling to its ceiling', async () => {
    const hour = hourApart(11);
    const campaign = tag();
    startedKey(hour, campaign);
    overflowKey(hour);

    const latches: boolean[] = [];
    for (const id of [addressId(), addressId()]) {
      latches.push(await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 }));
    }

    // The call that brings the set to its ceiling turned nobody away, so there
    // is nothing for an operator to be told about.
    expect(latches).toEqual([false, false]);
  });

  it('reports the latch on the first address the ceiling turns away', async () => {
    const hour = hourApart(12);
    const campaign = tag();
    startedKey(hour, campaign);
    overflowKey(hour);

    for (const id of [addressId(), addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }
    const refused = await count({
      hour,
      campaign,
      addressId: addressId(),
      decoy: false,
      ceiling: 2,
    });

    expect(refused).toBe(true);
  });

  it('reports no latch on a later refusal in the same bucket', async () => {
    const hour = hourApart(13);
    const campaign = tag();
    startedKey(hour, campaign);
    overflowKey(hour);

    for (const id of [addressId(), addressId(), addressId()]) {
      await count({ hour, campaign, addressId: id, decoy: false, ceiling: 2 });
    }
    const later = await count({
      hour,
      campaign,
      addressId: addressId(),
      decoy: false,
      ceiling: 2,
    });

    // `HSETNX` is what makes the flag idempotent across the rest of the bucket,
    // and the reply reports the raise rather than the flag's state.
    expect(later).toBe(false);
  });
});
