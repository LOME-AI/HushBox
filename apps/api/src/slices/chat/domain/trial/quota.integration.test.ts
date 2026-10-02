import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { TRIAL_MESSAGE_LIMIT, utcDayKey } from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/test-time';
import { consumeTrialQuota, readTrialQuotaRemaining, trialQuotaIpKey } from './quota.js';
import { hmacRateLimitId } from '../../../../lib/rate-limit/index.js';

/**
 * The trial 5/day quota against real Redis. Both identities count through the
 * shared rate-limit primitive, so the properties asserted here are the ones a
 * counter must have: the day in the key is what bounds the quota, the cap binds
 * exactly under concurrency on either identity, and an unreachable Redis
 * refuses.
 */

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for trial-quota tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const createdKeys: string[] = [];

/**
 * A distinct UTC day per test, far from the wall clock, so counters never
 * collide across tests or across a suite re-run within the counter's lifetime.
 */
let dayOffset = 0;
function freshNow(): Date {
  dayOffset += 1;
  return new Date(Date.UTC(2031, 0, dayOffset) + 12 * HOUR_MS);
}

/**
 * The keys the quota is expected to advance, written out rather than derived,
 * so the assertion fails if either the namespace or the day scoping moves. The
 * primitive keys the whole identifier, which is why the day and the identity
 * are joined first and digested together.
 */
function sessionKey(now: Date, sessionId: string): string {
  const dayScoped = [utcDayKey(now), sessionId].join(':');
  const key = `ratelimit:chat:trial-quota:session:${hmacRateLimitId(dayScoped)}`;
  createdKeys.push(key);
  return key;
}

function ipKey(now: Date, ipHash: string): string {
  const dayScoped = [utcDayKey(now), ipHash].join(':');
  const key = `ratelimit:chat:trial-quota:ip:${hmacRateLimitId(dayScoped)}`;
  createdKeys.push(key);
  return key;
}

function freshId(): string {
  return crypto.randomUUID();
}

async function spend(args: {
  sessionId: string;
  ipHash: string;
  now: Date;
}): Promise<{ allowed: boolean; count: number }> {
  sessionKey(args.now, args.sessionId);
  ipKey(args.now, args.ipHash);
  const outcome = await consumeTrialQuota(redis, args);
  return outcome._unsafeUnwrap();
}

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

describe('consumeTrialQuota', () => {
  it('admits every send up to the daily limit', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };

    const decisions = [];
    for (let attempt = 0; attempt < TRIAL_MESSAGE_LIMIT; attempt += 1) {
      decisions.push(await spend(args));
    }

    expect(decisions.map((decision) => decision.allowed)).toEqual(
      Array.from({ length: TRIAL_MESSAGE_LIMIT }, () => true)
    );
    expect(decisions.at(-1)).toEqual({ allowed: true, count: TRIAL_MESSAGE_LIMIT });
  });

  it('refuses the send past the daily limit', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };
    for (let attempt = 0; attempt < TRIAL_MESSAGE_LIMIT; attempt += 1) {
      await spend(args);
    }

    const decision = await spend(args);

    expect(decision).toEqual({ allowed: false, count: TRIAL_MESSAGE_LIMIT + 1 });
  });

  it('leaves the session counter untouched when the IP identity refuses', async () => {
    const now = freshNow();
    const sessionId = freshId();
    const ipHash = freshId();
    await redis.set(ipKey(now, ipHash), TRIAL_MESSAGE_LIMIT, { ex: 24 * 60 * 60 });

    const decision = await spend({ sessionId, ipHash, now });

    expect(decision.allowed).toBe(false);
    // All-or-nothing: a rotated token arriving behind an exhausted IP must not
    // spend a slot the send never got, or one address drains every token that
    // ever appears behind it.
    expect(await redis.get<number>(sessionKey(now, sessionId))).toBeNull();
  });

  it('advances only the refusing identity when the session identity refuses', async () => {
    const now = freshNow();
    const sessionId = freshId();
    const ipHash = freshId();
    await redis.set(sessionKey(now, sessionId), TRIAL_MESSAGE_LIMIT, { ex: 24 * 60 * 60 });

    const decision = await spend({ sessionId, ipHash, now });

    expect(decision).toEqual({ allowed: false, count: TRIAL_MESSAGE_LIMIT + 1 });
    expect(await redis.get<number>(ipKey(now, ipHash))).toBeNull();
  });

  it('counts each identity under the rate-limit namespace, scoped to the UTC day', async () => {
    const now = freshNow();
    const sessionId = freshId();
    const ipHash = freshId();

    await spend({ sessionId, ipHash, now });

    expect(await redis.get<number>(sessionKey(now, sessionId))).toBe(1);
    expect(await redis.get<number>(ipKey(now, ipHash))).toBe(1);
  });

  it('starts a fresh quota on the next UTC day', async () => {
    const firstDay = freshNow();
    const sessionId = freshId();
    const ipHash = freshId();
    for (let attempt = 0; attempt <= TRIAL_MESSAGE_LIMIT; attempt += 1) {
      await spend({ sessionId, ipHash, now: firstDay });
    }
    const nextDay = new Date(firstDay.getTime() + 24 * 60 * 60 * 1000);

    const decision = await spend({ sessionId, ipHash, now: nextDay });

    expect(decision).toEqual({ allowed: true, count: 1 });
  });

  it('bounds each counter at a whole day rather than at the next wall-clock midnight', async () => {
    const now = freshNow();
    const sessionId = freshId();
    const ipHash = freshId();

    await spend({ sessionId, ipHash, now });

    expect(await redis.ttl(sessionKey(now, sessionId))).toBe(24 * 60 * 60);
    expect(await redis.ttl(ipKey(now, ipHash))).toBe(24 * 60 * 60);
  });

  it('refuses a rotated trial token once the IP has spent the day', async () => {
    const now = freshNow();
    const ipHash = freshId();
    for (let attempt = 0; attempt < TRIAL_MESSAGE_LIMIT; attempt += 1) {
      await spend({ sessionId: freshId(), ipHash, now });
    }

    const decision = await spend({ sessionId: freshId(), ipHash, now });

    expect(decision).toEqual({ allowed: false, count: TRIAL_MESSAGE_LIMIT + 1 });
  });

  it('names the IP counter a caller must clear', async () => {
    // The suite cleanup that clears the sentinel identity between runs derives
    // its key from here rather than writing the template out a second time.
    // The literal-key assertions above are what pin the template itself, so a
    // move fails there rather than silently agreeing with itself.
    const now = freshNow();
    const ipHash = freshId();
    await spend({ sessionId: freshId(), ipHash, now });

    const key = trialQuotaIpKey(now, ipHash)._unsafeUnwrap();

    expect(await redis.get<number>(key)).toBe(1);
  });

  it('refuses to name a key for an identity past the length bound', () => {
    const named = trialQuotaIpKey(freshNow(), 'i'.repeat(512));

    expect(named._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when Redis is unreachable', async () => {
    const outcome = await consumeTrialQuota(unreachableRedis, {
      sessionId: freshId(),
      ipHash: freshId(),
      now: freshNow(),
    });

    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readTrialQuotaRemaining', () => {
  async function peek(args: { sessionId: string; ipHash: string; now: Date }): Promise<number> {
    sessionKey(args.now, args.sessionId);
    ipKey(args.now, args.ipHash);
    const outcome = await readTrialQuotaRemaining(redis, args);
    return outcome._unsafeUnwrap();
  }

  it('reports the whole daily allowance when neither identity has spent', async () => {
    const remaining = await peek({ sessionId: freshId(), ipHash: freshId(), now: freshNow() });

    expect(remaining).toBe(TRIAL_MESSAGE_LIMIT);
  });

  it('subtracts the slots the session has already spent', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };
    await spend(args);
    await spend(args);

    expect(await peek(args)).toBe(TRIAL_MESSAGE_LIMIT - 2);
  });

  it('reports the stricter of the two identities', async () => {
    const now = freshNow();
    const ipHash = freshId();
    // The IP has spent three slots behind rotated tokens; a brand-new token on
    // that IP can still send only what the IP counter leaves.
    await spend({ sessionId: freshId(), ipHash, now });
    await spend({ sessionId: freshId(), ipHash, now });
    await spend({ sessionId: freshId(), ipHash, now });

    expect(await peek({ sessionId: freshId(), ipHash, now })).toBe(TRIAL_MESSAGE_LIMIT - 3);
  });

  it('reports the session count when the session is the stricter identity', async () => {
    const now = freshNow();
    const sessionId = freshId();
    const roamedToIpHash = freshId();
    // One token that changed networks: three slots spent behind the first IP,
    // one behind the second. The session has spent four, the current IP one,
    // and the answer must be the session's — reading the IP alone would offer
    // an allowance the send gate then refuses.
    const firstIpHash = freshId();
    await spend({ sessionId, ipHash: firstIpHash, now });
    await spend({ sessionId, ipHash: firstIpHash, now });
    await spend({ sessionId, ipHash: firstIpHash, now });
    await spend({ sessionId, ipHash: roamedToIpHash, now });

    expect(await peek({ sessionId, ipHash: roamedToIpHash, now })).toBe(TRIAL_MESSAGE_LIMIT - 4);
  });

  it('reports zero rather than a negative allowance once the day is exhausted', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };
    for (let attempt = 0; attempt <= TRIAL_MESSAGE_LIMIT + 2; attempt += 1) {
      await spend(args);
    }

    expect(await peek(args)).toBe(0);
  });

  it('spends nothing it reads', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };
    await spend(args);

    await peek(args);
    await peek(args);

    expect(await redis.get<number>(sessionKey(now, args.sessionId))).toBe(1);
    expect(await redis.get<number>(ipKey(now, args.ipHash))).toBe(1);
  });

  it('fails closed when Redis is unreachable', async () => {
    const outcome = await readTrialQuotaRemaining(unreachableRedis, {
      sessionId: freshId(),
      ipHash: freshId(),
      now: freshNow(),
    });

    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('refuses to read an identity past the key length bound', async () => {
    const outcome = await readTrialQuotaRemaining(redis, {
      sessionId: 's'.repeat(512),
      ipHash: freshId(),
      now: freshNow(),
    });

    expect(outcome._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('consumeTrialQuota under concurrency', () => {
  it('admits the whole day quota when it is issued all at once', async () => {
    const now = freshNow();
    const args = { sessionId: freshId(), ipHash: freshId(), now };

    const decisions = await Promise.all(
      Array.from({ length: TRIAL_MESSAGE_LIMIT }, () => spend(args))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(TRIAL_MESSAGE_LIMIT);
  });

  it('admits exactly the cap when one session races far past it', async () => {
    const now = freshNow();
    const sessionId = freshId();

    // Every attempt carries its own IP, so the session counter is the only one
    // that can bind and the measurement is exact rather than an upper bound.
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => spend({ sessionId, ipHash: freshId(), now }))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(TRIAL_MESSAGE_LIMIT);
  });

  it('admits exactly the cap when one IP races far past it behind rotated tokens', async () => {
    const now = freshNow();
    const ipHash = freshId();

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => spend({ sessionId: freshId(), ipHash, now }))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(TRIAL_MESSAGE_LIMIT);
  });
});
