import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineKey } from './define-key.js';
import {
  redisDel,
  redisEval,
  redisGet,
  redisGetDel,
  redisMGet,
  redisMGetEntry,
  redisHGetAll,
  redisScard,
  redisSet,
  redisSetNx,
  redisSmembers,
  redisTtl,
} from './operations.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for redis integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// A client whose every call fails fast: nothing listens on the discard port.
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const PREFIX = `test:redis-registry:${crypto.randomUUID()}`;
const createdKeys: string[] = [];

function trackKey(key: string): string {
  createdKeys.push(key);
  return key;
}

const recordDefinition = defineKey({
  schema: z.object({ total: z.number(), openedAt: z.number() }),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:counter:${id}`,
});

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

describe('redisGet', () => {
  it('returns null for a missing key', async () => {
    const result = await redisGet(redis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the stored value validated through the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { total: 2, openedAt: 5 });
    const result = await redisGet(redis, recordDefinition, id);
    expect(result._unsafeUnwrap()).toEqual({ total: 2, openedAt: 5 });
  });

  it('surfaces a validation error when the stored value fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { wrong: true });
    const result = await redisGet(redis, recordDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisGet(unreachableRedis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

const wordDefinition = defineKey({
  schema: z.string().min(5),
  ttlSeconds: 120,
  buildKey: (id: string) => `${PREFIX}:word:${id}`,
});

describe('redisSet', () => {
  it('round-trips a value readable by redisGet', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const written = await redisSet(redis, recordDefinition, { total: 1, openedAt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const read = await redisGet(redis, recordDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ total: 1, openedAt: 9 });
  });

  it('applies the definition ttlSeconds to the written key', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(recordDefinition.buildKey(id));
    const written = await redisSet(redis, recordDefinition, { total: 1, openedAt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(recordDefinition.ttlSeconds);
  });

  it('rejects a schema-invalid value with a validation error', async () => {
    const id = crypto.randomUUID();
    const result = await redisSet(redis, wordDefinition, 'ab', id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('writes nothing when the value fails the schema', async () => {
    const id = crypto.randomUUID();
    const result = await redisSet(redis, wordDefinition, 'ab', id);
    expect(result.isErr()).toBe(true);
    expect(await redis.get(wordDefinition.buildKey(id))).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisSet(
      unreachableRedis,
      recordDefinition,
      { total: 1, openedAt: 9 },
      crypto.randomUUID()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisDel', () => {
  it('removes the key', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const written = await redisSet(redis, recordDefinition, { total: 1, openedAt: 9 }, id);
    expect(written.isOk()).toBe(true);
    const deleted = await redisDel(redis, recordDefinition, id);
    expect(deleted.isOk()).toBe(true);
    const read = await redisGet(redis, recordDefinition, id);
    expect(read._unsafeUnwrap()).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisDel(unreachableRedis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisGetDel', () => {
  it('returns null for a missing key', async () => {
    const result = await redisGetDel(redis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the stored value validated through the schema and removes the key', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { total: 4, openedAt: 8 });
    const result = await redisGetDel(redis, recordDefinition, id);
    expect(result._unsafeUnwrap()).toEqual({ total: 4, openedAt: 8 });
    expect(await redis.get(recordDefinition.buildKey(id))).toBeNull();
  });

  it('surfaces a validation error when the stored value fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { wrong: true });
    const result = await redisGetDel(redis, recordDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisGetDel(unreachableRedis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('lets exactly one of two racing callers win the value', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { total: 7, openedAt: 1 });
    const [first, second] = await Promise.all([
      redisGetDel(redis, recordDefinition, id),
      redisGetDel(redis, recordDefinition, id),
    ]);
    const values = [first._unsafeUnwrap(), second._unsafeUnwrap()];
    const winners = values.filter((value) => value !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ total: 7, openedAt: 1 });
  });
});

describe('redisSetNx', () => {
  it('claims a missing key and reports the claim won', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const result = await redisSetNx(redis, recordDefinition, { total: 1, openedAt: 2 }, id);
    expect(result._unsafeUnwrap()).toBe(true);
    const read = await redisGet(redis, recordDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ total: 1, openedAt: 2 });
  });

  it('reports a lost claim without overwriting the existing value', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const seeded = await redisSetNx(redis, recordDefinition, { total: 1, openedAt: 2 }, id);
    seeded._unsafeUnwrap();
    const second = await redisSetNx(redis, recordDefinition, { total: 9, openedAt: 9 }, id);
    expect(second._unsafeUnwrap()).toBe(false);
    const read = await redisGet(redis, recordDefinition, id);
    expect(read._unsafeUnwrap()).toEqual({ total: 1, openedAt: 2 });
  });

  it('lets exactly one of two racing claimants win', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const [first, second] = await Promise.all([
      redisSetNx(redis, recordDefinition, { total: 1, openedAt: 1 }, id),
      redisSetNx(redis, recordDefinition, { total: 2, openedAt: 2 }, id),
    ]);
    const wins = [first._unsafeUnwrap(), second._unsafeUnwrap()].filter(Boolean);
    expect(wins).toHaveLength(1);
  });

  it('applies the definition ttlSeconds to a won claim', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(recordDefinition.buildKey(id));
    const seeded = await redisSetNx(redis, recordDefinition, { total: 1, openedAt: 2 }, id);
    seeded._unsafeUnwrap();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(recordDefinition.ttlSeconds);
  });

  it('rejects a schema-invalid value with a validation error', async () => {
    const id = crypto.randomUUID();
    const result = await redisSetNx(redis, wordDefinition, 'ab', id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisSetNx(
      unreachableRedis,
      recordDefinition,
      { total: 1, openedAt: 2 },
      crypto.randomUUID()
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

const numberDefinition = defineKey({
  schema: z.coerce.number(),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:number:${id}`,
});

/**
 * Wraps a Redis client so `get`/`mget` invocations are counted, proving how
 * many network round-trips an operation issues. Spying on the Upstash client's
 * methods directly is unreliable (they are accessor-defined).
 */
function countingRedis(target: Redis): { redis: Redis; roundTrips: () => number } {
  let count = 0;
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if ((property === 'get' || property === 'mget') && typeof value === 'function') {
        return (...args: unknown[]): unknown => {
          count += 1;
          return (value as (...callArgs: unknown[]) => unknown).apply(object, args);
        };
      }
      return value;
    },
  });
  return { redis: proxy, roundTrips: () => count };
}

describe('redisMGet', () => {
  it('fetches heterogeneous keys in a single round-trip preserving order', async () => {
    const wordId = crypto.randomUUID();
    const numberId = crypto.randomUUID();
    trackKey(wordDefinition.buildKey(wordId));
    trackKey(numberDefinition.buildKey(numberId));
    const wordWritten = await redisSet(redis, wordDefinition, 'hello', wordId);
    wordWritten._unsafeUnwrap();
    const numberWritten = await redisSet(redis, numberDefinition, 42, numberId);
    numberWritten._unsafeUnwrap();
    const counting = countingRedis(redis);
    const result = await redisMGet(counting.redis, [
      redisMGetEntry(wordDefinition, wordId),
      redisMGetEntry(numberDefinition, numberId),
    ]);
    expect(result._unsafeUnwrap()).toEqual(['hello', 42]);
    expect(counting.roundTrips()).toBe(1);
  });

  it('returns null for a missing key while parsing present siblings', async () => {
    const wordId = crypto.randomUUID();
    trackKey(wordDefinition.buildKey(wordId));
    const written = await redisSet(redis, wordDefinition, 'world', wordId);
    written._unsafeUnwrap();
    const result = await redisMGet(redis, [
      redisMGetEntry(wordDefinition, wordId),
      redisMGetEntry(numberDefinition, crypto.randomUUID()),
    ]);
    expect(result._unsafeUnwrap()).toEqual(['world', null]);
  });

  it('surfaces a validation error when a stored value fails its schema', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(wordDefinition.buildKey(id)), 'ab');
    const result = await redisMGet(redis, [redisMGetEntry(wordDefinition, id)]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisMGet(unreachableRedis, [
      redisMGetEntry(wordDefinition, crypto.randomUUID()),
      redisMGetEntry(numberDefinition, crypto.randomUUID()),
    ]);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisTtl', () => {
  it('returns null for a missing key', async () => {
    const result = await redisTtl(redis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns the remaining seconds for a live key', async () => {
    const id = crypto.randomUUID();
    trackKey(recordDefinition.buildKey(id));
    const seeded = await redisSet(redis, recordDefinition, { total: 1, openedAt: 2 }, id);
    seeded._unsafeUnwrap();
    const result = await redisTtl(redis, recordDefinition, id);
    const remaining = result._unsafeUnwrap();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(recordDefinition.ttlSeconds);
  });

  it('returns null for a key without an expiry', async () => {
    const id = crypto.randomUUID();
    await redis.set(trackKey(recordDefinition.buildKey(id)), { total: 1, openedAt: 2 });
    const result = await redisTtl(redis, recordDefinition, id);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisTtl(unreachableRedis, recordDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

/** A set family whose members are plain labels, so a member's own shape is not the subject. */
const setDefinition = defineKey({
  schema: z.string(),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:set:${id}`,
});

// The client JSON-parses what it reads back, so the flag Redis holds as the
// string "1" arrives as the number 1 — which is what the schema has to admit.
const hashDefinition = defineKey({
  schema: z.literal(1),
  ttlSeconds: 60,
  buildKey: (id: string) => `${PREFIX}:hash:${id}`,
});

describe('redisScard', () => {
  it('answers zero for a set that does not exist', async () => {
    const result = await redisScard(redis, setDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBe(0);
  });

  it('answers the number of distinct members', async () => {
    const id = crypto.randomUUID();
    await redis.sadd(trackKey(setDefinition.buildKey(id)), 'a', 'b', 'a');
    const size = await redisScard(redis, setDefinition, id);
    expect(size._unsafeUnwrap()).toBe(2);
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisScard(unreachableRedis, setDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisSmembers', () => {
  it('answers an empty list for a set that does not exist', async () => {
    const result = await redisSmembers(redis, setDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('answers every member validated through the schema', async () => {
    const id = crypto.randomUUID();
    await redis.sadd(trackKey(setDefinition.buildKey(id)), 'first', 'second');
    const result = await redisSmembers(redis, setDefinition, id);
    expect([...result._unsafeUnwrap()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'first',
      'second',
    ]);
  });

  it('surfaces a validation error when a stored member fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.sadd(trackKey(hashDefinition.buildKey(id)), 'not-one');
    const result = await redisSmembers(redis, hashDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisSmembers(unreachableRedis, setDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('redisHGetAll', () => {
  it('answers an empty record for a hash that does not exist', async () => {
    const result = await redisHGetAll(redis, hashDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toEqual({});
  });

  it('answers every field validated through the schema', async () => {
    const id = crypto.randomUUID();
    await redis.hset(trackKey(hashDefinition.buildKey(id)), { 'views:/welcome': '1' });
    const result = await redisHGetAll(redis, hashDefinition, id);
    expect(result._unsafeUnwrap()).toEqual({ 'views:/welcome': 1 });
  });

  it('surfaces a validation error when a stored field fails the schema', async () => {
    const id = crypto.randomUUID();
    await redis.hset(trackKey(hashDefinition.buildKey(id)), { 'views:/welcome': 'two' });
    const result = await redisHGetAll(redis, hashDefinition, id);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisHGetAll(unreachableRedis, hashDefinition, crypto.randomUUID());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

const COUNT_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
return redis.call('SCARD', KEYS[1])
`;

describe('redisEval', () => {
  it('runs the script and validates its reply through the schema', async () => {
    const id = crypto.randomUUID();
    const key = trackKey(setDefinition.buildKey(id));
    const first = await redisEval(redis, {
      script: COUNT_SCRIPT,
      reply: z.number(),
      keys: [key],
      args: ['one'],
    });
    expect(first._unsafeUnwrap()).toBe(1);
    const replay = await redisEval(redis, {
      script: COUNT_SCRIPT,
      reply: z.number(),
      keys: [key],
      args: ['one'],
    });
    expect(replay._unsafeUnwrap()).toBe(1);
  });

  it('surfaces a validation error when the reply fails the schema', async () => {
    const key = trackKey(setDefinition.buildKey(crypto.randomUUID()));
    const result = await redisEval(redis, {
      script: COUNT_SCRIPT,
      reply: z.string(),
      keys: [key],
      args: ['one'],
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unavailable error when the script itself errors', async () => {
    const key = trackKey(setDefinition.buildKey(crypto.randomUUID()));
    const result = await redisEval(redis, {
      script: 'this is not lua',
      reply: z.number(),
      keys: [key],
      args: [],
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('surfaces an unavailable error when redis is unreachable', async () => {
    const result = await redisEval(unreachableRedis, {
      script: COUNT_SCRIPT,
      reply: z.number(),
      keys: [setDefinition.buildKey(crypto.randomUUID())],
      args: ['one'],
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
