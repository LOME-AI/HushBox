import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { clear, consume, rateLimitKey } from '../lib/rate-limit/index.js';
import { feedbackSubmitRateLimit } from '../slices/feedback/domain/rate-limit.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import type { RateLimitDefinition } from '../lib/rate-limit/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for registry rate-limit tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const createdKeys: string[] = [];
function trackKey(definition: RateLimitDefinition, id: string): string {
  const key = rateLimitKey(definition, id)._unsafeUnwrap();
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

/**
 * Offers `attempts` checks against one identifier all at once and counts how
 * many were admitted. The old read-then-write window admitted `cap × in-flight`
 * here — the cap did not bind at all under a burst — so the figure this returns
 * is the migration's whole point, measured on a real registry entry rather than
 * on a synthetic one.
 */
async function admittedUnderBurst(
  definition: RateLimitDefinition,
  id: string,
  attempts: number
): Promise<number> {
  const decisions = await Promise.all(
    Array.from({ length: attempts }, () => consume(redis, definition, id))
  );
  return decisions.filter((decision) => decision._unsafeUnwrap().allowed).length;
}

describe('a reservation entry under concurrency', () => {
  const definition = IDENTITY_KEYS.loginLockout;

  it('admits exactly its cap when its cap-worth of attempts race', async () => {
    const id = crypto.randomUUID();
    trackKey(definition, id);

    expect(await admittedUnderBurst(definition, id, definition.maxAttempts)).toBe(
      definition.maxAttempts
    );
  });

  it('admits exactly its cap when forty times its cap race', async () => {
    const id = crypto.randomUUID();
    trackKey(definition, id);

    expect(await admittedUnderBurst(definition, id, definition.maxAttempts * 40)).toBe(
      definition.maxAttempts
    );
  });

  it('starts a fresh window after a verified success clears it', async () => {
    const id = crypto.randomUUID();
    trackKey(definition, id);
    await admittedUnderBurst(definition, id, definition.maxAttempts * 2);

    const cleared = await clear(redis, definition, id);
    cleared._unsafeUnwrap();

    expect(await admittedUnderBurst(definition, id, definition.maxAttempts)).toBe(
      definition.maxAttempts
    );
  });
});

describe('a throttle entry under concurrency', () => {
  const definition = feedbackSubmitRateLimit;

  it('admits exactly its cap when its cap-worth of attempts race', async () => {
    const id = crypto.randomUUID();
    trackKey(definition, id);

    expect(await admittedUnderBurst(definition, id, definition.maxAttempts)).toBe(
      definition.maxAttempts
    );
  });

  it('admits exactly its cap when twenty times its cap race', async () => {
    const id = crypto.randomUUID();
    trackKey(definition, id);

    expect(await admittedUnderBurst(definition, id, definition.maxAttempts * 20)).toBe(
      definition.maxAttempts
    );
  });

  it('leaves each identifier its own budget', async () => {
    const exhausted = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    trackKey(definition, exhausted);
    trackKey(definition, fresh);
    await admittedUnderBurst(definition, exhausted, definition.maxAttempts * 2);

    const decision = await consume(redis, definition, fresh);

    expect(decision._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
  });
});
