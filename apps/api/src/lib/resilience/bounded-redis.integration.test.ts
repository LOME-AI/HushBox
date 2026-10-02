import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { createBoundedRedis } from './bounded-redis.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for redis integration tests'
  );
}

const CREDENTIALS = {
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
} as const;

/** Far above any local round trip: this file is about the fallback, not the deadline. */
const PATIENT_BOUND_MS = 5000;

/**
 * A script body no store has ever loaded, so its digest cannot be in any script
 * cache and EVALSHA must miss. A body the shared local store already holds
 * answers whether or not the client's fallback works, which is what kept this
 * defect invisible; minting one per call is what forces the miss without
 * flushing state other runs are using.
 */
function uncachedScript(): { readonly body: string; readonly reply: string } {
  const reply = crypto.randomUUID();
  return { body: `return '${reply}'`, reply };
}

describe('createBoundedRedis against the local store', () => {
  it('leaves a freshly minted script uncached, so EVALSHA misses', async () => {
    const { body } = uncachedScript();
    const raw = new Redis({ ...CREDENTIALS });

    const rejection = await raw
      .createScript(body)
      .evalsha([], [])
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message.toLowerCase()).toContain('noscript');
  });

  it('answers a script the store has never loaded, through the EVAL fallback', async () => {
    const { body, reply } = uncachedScript();
    const redis = createBoundedRedis(CREDENTIALS, PATIENT_BOUND_MS);

    await expect(redis.createScript<string>(body).exec([], [])).resolves.toBe(reply);

    // EVAL is the only command that loads a script, so the digest answering
    // now is what says the fallback ran rather than the cache having been warm.
    await expect(new Redis({ ...CREDENTIALS }).createScript(body).evalsha([], [])).resolves.toBe(
      reply
    );
  });
});
