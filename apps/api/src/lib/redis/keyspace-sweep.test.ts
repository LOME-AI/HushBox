import { describe, expect, it, vi } from 'vitest';
import { deleteKeysMatching } from './keyspace-sweep.js';
import type { Redis } from '@upstash/redis';

/** A client whose `eval` records what it was handed and answers a fixed reply. */
function stubEvalRedis(reply: unknown): {
  redis: Redis;
  calls: { script: string; keys: string[]; args: string[] }[];
} {
  const calls: { script: string; keys: string[]; args: string[] }[] = [];
  const evaluate = vi.fn((script: string, keys: string[], args: string[]) => {
    calls.push({ script, keys, args });
    return Promise.resolve(reply);
  });
  return { redis: { eval: evaluate } as unknown as Redis, calls };
}

describe('deleteKeysMatching', () => {
  it('walks every pattern inside one script execution', async () => {
    const { redis, calls } = stubEvalRedis(0);

    await deleteKeysMatching(redis, ['one:*', 'two:*', 'three:*']);

    expect(calls).toHaveLength(1);
  });

  it('names every pattern as a key of the script', async () => {
    // The patterns ride in KEYS rather than in ARGV so the vitest harness's
    // per-run key scoping can reach them: a pattern it cannot see walks every
    // concurrent run's keyspace and deletes what it finds there.
    const { redis, calls } = stubEvalRedis(0);

    await deleteKeysMatching(redis, ['one:*', 'two:*']);

    expect(calls[0]?.keys).toEqual(['one:*', 'two:*']);
  });

  it('answers the number of keys the script deleted', async () => {
    const { redis } = stubEvalRedis(7);

    expect(await deleteKeysMatching(redis, ['one:*'])).toBe(7);
  });

  it('issues no command at all when it is given no pattern', async () => {
    // Not an optimization: a script naming no key is invisible to the run
    // scoping, so an empty sweep that still ran would walk the whole keyspace.
    const { redis, calls } = stubEvalRedis(0);

    expect(await deleteKeysMatching(redis, [])).toBe(0);
    expect(calls).toEqual([]);
  });

  it('fails fast when the script answers something that is not a count', async () => {
    const { redis } = stubEvalRedis('nine');

    await expect(deleteKeysMatching(redis, ['one:*'])).rejects.toThrow(/count/);
  });
});
