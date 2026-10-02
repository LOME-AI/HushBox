import { Redis } from '@upstash/redis';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteKeysMatching } from './keyspace-sweep.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for redis integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/**
 * More keys than one sweep step's `COUNT` hint covers, so the script's cursor
 * loop has to take a second turn to reach the end of the keyspace.
 */
const WIDER_THAN_ONE_SCAN_PAGE = 1200;

const written: string[] = [];

/**
 * Writes a key this file owns and will clean up, whatever the case asserts.
 *
 * Every case scopes its keys beneath a random id it mints itself, which is what
 * makes an exact delete count sound here: this database is shared with whatever
 * else is running, and no key but the case's own can match a pattern under that
 * id.
 */
async function write(key: string): Promise<string> {
  written.push(key);
  await redis.set(key, '1');
  return key;
}

afterEach(async () => {
  const keys = written.splice(0);
  for (let start = 0; start < keys.length; start += 256) {
    await redis.del(...keys.slice(start, start + 256));
  }
});

describe('deleteKeysMatching', () => {
  it('deletes every key its patterns reach and leaves the rest standing', async () => {
    const run = crypto.randomUUID();
    const swept = [
      await write(`sweep:${run}:alpha:one`),
      await write(`sweep:${run}:alpha:two`),
      await write(`sweep:${run}:beta:one`),
    ];
    const bystander = await write(`sweep:${run}:gamma:one`);

    const deleted = await deleteKeysMatching(redis, [
      `sweep:${run}:alpha:*`,
      `sweep:${run}:beta:*`,
    ]);

    expect(deleted).toBe(swept.length);
    expect(await redis.mget(...swept)).toEqual([null, null, null]);
    expect(await redis.get(bystander)).toBe(1);
  });

  it('reaches a match that sits past the first page of the walk', async () => {
    // The cursor loop's reason to exist: a keyspace wider than one step's hint
    // answers a non-zero cursor, and a sweep that stopped there would leave the
    // matches on every later page standing.
    const run = crypto.randomUUID();
    const filler = Object.fromEntries(
      Array.from({ length: WIDER_THAN_ONE_SCAN_PAGE }, (_, index) => [
        `sweep:${run}:filler:${String(index)}`,
        '1',
      ])
    );
    written.push(...Object.keys(filler));
    await redis.mset(filler);
    const target = await write(`sweep:${run}:target:only`);

    const deleted = await deleteKeysMatching(redis, [`sweep:${run}:target:*`]);

    expect(deleted).toBe(1);
    expect(await redis.get(target)).toBeNull();
  });
});
