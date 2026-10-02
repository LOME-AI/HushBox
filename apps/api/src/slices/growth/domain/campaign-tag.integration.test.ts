import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN } from '@hushbox/shared';
import { GROWTH_REDIS_KEYS, redisGet } from '../../../lib/redis/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { resolveCampaignTag } from './campaign-tag.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for growth campaign integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const registryKey = GROWTH_REDIS_KEYS.activeCampaigns.buildKey();

afterAll(async () => {
  await redis.del(registryKey);
});

/** A fresh tag nothing else in this run can be counting under. */
function tag(): string {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

describe('resolveCampaignTag', () => {
  it('answers direct when the beacon carried no tag', async () => {
    const listActiveTags = vi.fn(() => okAsync<readonly string[]>([]));
    const result = await resolveCampaignTag({ redis, listActiveTags, tag: undefined });
    expect(result._unsafeUnwrap()).toBe(GROWTH_DIRECT_CAMPAIGN);
    // Nothing is read for a tag that was never sent.
    expect(listActiveTags).not.toHaveBeenCalled();
  });

  it('answers the tag itself when it names an active campaign', async () => {
    const active = tag();
    await redis.del(registryKey);
    const result = await resolveCampaignTag({
      redis,
      listActiveTags: () => okAsync<readonly string[]>([active]),
      tag: active,
    });
    expect(result._unsafeUnwrap()).toBe(active);
  });

  // A stale link is a real visit and has to count somewhere; refusing it would
  // make an expired campaign look like an outage on the marketing page.
  it('folds a tag no campaign carries into the unknown tag', async () => {
    await redis.del(registryKey);
    const result = await resolveCampaignTag({
      redis,
      listActiveTags: () => okAsync<readonly string[]>([tag()]),
      tag: tag(),
    });
    expect(result._unsafeUnwrap()).toBe(GROWTH_UNKNOWN_CAMPAIGN);
  });

  it('caches the active tags so a flood of beacons costs one database read', async () => {
    const active = tag();
    await redis.del(registryKey);
    const listActiveTags = vi.fn(() => okAsync<readonly string[]>([active]));

    const first = await resolveCampaignTag({ redis, listActiveTags, tag: active });
    const second = await resolveCampaignTag({ redis, listActiveTags, tag: active });
    const stored = await redisGet(redis, GROWTH_REDIS_KEYS.activeCampaigns);

    expect(first._unsafeUnwrap()).toBe(active);
    expect(second._unsafeUnwrap()).toBe(active);
    expect(listActiveTags).toHaveBeenCalledTimes(1);
    expect(stored._unsafeUnwrap()).toEqual([active]);
  });

  it('surfaces the read failure rather than guessing a tag', async () => {
    await redis.del(registryKey);
    const result = await resolveCampaignTag({
      redis,
      listActiveTags: () => errAsync(unavailableError('campaign read failed')),
      tag: tag(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
