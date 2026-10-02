import { Redis } from '@upstash/redis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimitBound } from './bound.js';
import { MAX_IDENTIFIER_LENGTH } from './consume.js';
import { clear, consume, rateLimitKey } from './index.js';
import type { RateLimitDecision, RateLimitDefinition } from './index.js';
import type { ReservationLimit, ThrottleLimit } from './index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for rate-limit integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// A client whose every call fails fast: nothing listens on the discard port.
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

/** A Redis whose script call answers at once — enough to build the timeout policy. */
const answersAtOnce = {
  createScript: () => ({ exec: () => Promise.resolve('allowed:1:1:0') }),
} as unknown as Redis;

/** A Redis whose delete never settles, so only the bound can end the wait. */
const neverDeleting = {
  del: () => new Promise<number>(() => {}),
} as unknown as Redis;

const PREFIX = `test:rate-limit:${crypto.randomUUID()}`;
const createdKeys: string[] = [];

function reservation(maxAttempts: number, windowSeconds = 60): ReservationLimit {
  return {
    kind: 'reservation',
    maxAttempts,
    windowSeconds,
    buildKey: (id: string) => `${PREFIX}:reservation:${id}`,
  };
}

function throttle(maxAttempts: number, windowSeconds = 60): ThrottleLimit {
  return {
    kind: 'throttle',
    maxAttempts,
    windowSeconds,
    buildKey: (id: string) => `${PREFIX}:throttle:${id}`,
  };
}

/** The key the counter for `id` actually lives at. */
function keyOf(definition: RateLimitDefinition, id: string): string {
  return rateLimitKey(definition, id)._unsafeUnwrap();
}

function freshId(definition: RateLimitDefinition): string {
  const id = crypto.randomUUID();
  createdKeys.push(keyOf(definition, id));
  return id;
}

/** One attempt, unwrapped — for the arrangement steps a test does not assert on. */
async function spend(definition: RateLimitDefinition, id: string): Promise<RateLimitDecision> {
  const decision = await consume(redis, definition, id);
  return decision._unsafeUnwrap();
}

/**
 * Builds the shared timeout policy, which a test must do before it fakes the
 * clock. The policy imports `cockatiel` lazily on first use and awaits that
 * import before the deadline is ever scheduled; the import resolves on the real
 * macrotask queue rather than inside the window `advanceTimersByTimeAsync`
 * advances, so a test that fakes the clock over a policy built for the first
 * time schedules its deadline only after the advance has already returned, and
 * the bounded call never settles.
 */
async function buildTimeoutPolicy(): Promise<void> {
  // Unwrapped so a stub that stops answering fails loudly here, rather than
  // leaving the policy unbuilt and the tests below hanging on a faked clock.
  const built = await consume(answersAtOnce, throttle(1), 'policy-build');
  built._unsafeUnwrap();
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

describe('consume', () => {
  it('admits an attempt below the cap and reports the resulting count', async () => {
    const definition = reservation(3);
    const id = freshId(definition);

    const decision = await consume(redis, definition, id);

    expect(decision._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
  });

  it('admits the attempt that reaches the cap', async () => {
    const definition = throttle(2, 45);
    const id = freshId(definition);
    await spend(definition, id);

    const decision = await consume(redis, definition, id);

    expect(decision._unsafeUnwrap()).toEqual({ allowed: true, count: 2 });
  });

  it('refuses the attempt past the cap with a retry-after inside the window', async () => {
    const definition = throttle(2, 45);
    const id = freshId(definition);
    await spend(definition, id);
    await spend(definition, id);

    const decision = await consume(redis, definition, id);

    const value = decision._unsafeUnwrap();
    expect(value.allowed).toBe(false);
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.count).toBe(3);
    expect(value.retryAfterSeconds).toBeGreaterThan(0);
    expect(value.retryAfterSeconds).toBeLessThanOrEqual(45);
  });

  // Retry-after is the refusing counter key's real remaining lifetime, not the
  // entry's configured window: a caller arriving late in a window must be told
  // the seconds actually left on it, or a 429 sends every refused caller back
  // at the same moment a full window later. The seeded lifetime is an order of
  // magnitude short of the window precisely so no single number satisfies both
  // readings — an assertion a constant `windowSeconds` could pass would be
  // measuring nothing.
  it('answers retry-after from the counter key lifetime rather than the configured window', async () => {
    const definition = throttle(2, 60);
    const id = freshId(definition);
    await redis.set(keyOf(definition, id), 2, { ex: 5 });

    const decision = await consume(redis, definition, id);

    const value = decision._unsafeUnwrap();
    expect(value.allowed).toBe(false);
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.retryAfterSeconds).toBeGreaterThanOrEqual(4);
    expect(value.retryAfterSeconds).toBeLessThanOrEqual(5);
  });

  it('keeps counting past the cap so a caller can detect the crossing attempt', async () => {
    const definition = reservation(1);
    const id = freshId(definition);
    await spend(definition, id);

    const first = await spend(definition, id);
    const second = await spend(definition, id);

    expect(first.count).toBe(2);
    expect(second.count).toBe(3);
  });

  it('anchors the window at the first attempt and never extends it', async () => {
    const definition = throttle(10, 60);
    const id = freshId(definition);
    const key = keyOf(definition, id);
    await spend(definition, id);
    const afterFirst = await redis.pttl(key);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await spend(definition, id);

    const afterSecond = await redis.pttl(key);
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeLessThan(afterFirst);
  });

  it('repairs a counter left without an expiry', async () => {
    const definition = throttle(10, 60);
    const id = freshId(definition);
    const key = keyOf(definition, id);
    await redis.incr(key);
    const beforeRepair = await redis.pttl(key);

    await spend(definition, id);

    expect(beforeRepair).toBe(-1);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('refuses when Redis is unreachable, never admitting', async () => {
    const decision = await consume(unreachableRedis, reservation(5), crypto.randomUUID());

    expect(decision.isErr()).toBe(true);
    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  // A non-positive window makes `EXPIRE … NX` DELETE the key, so every INCR
  // returns 1 and the cap silently stops binding. It must refuse, not admit.
  it.each([0, -1, 0.5, Number.NaN])(
    'refuses every attempt when the window is %p rather than a positive integer',
    async (windowSeconds) => {
      const definition = throttle(5, windowSeconds);
      const id = freshId(definition);

      const decisions = await Promise.all(
        Array.from({ length: 50 }, () => consume(redis, definition, id))
      );

      expect(decisions.filter((decision) => decision.isErr())).toHaveLength(50);
      expect(decisions[0]?._unsafeUnwrapErr().code).toBe('unavailable');
    }
  );

  it('refuses when the script returns an outcome it cannot parse', async () => {
    const fakeRedis = {
      createScript: () => ({ exec: () => Promise.resolve('yes') }),
    } as unknown as typeof redis;

    const decision = await consume(fakeRedis, reservation(5), crypto.randomUUID());

    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('consume identifier encoding', () => {
  // Sibling entries whose prefixes differ by one delimiter segment. Without
  // encoding, `buildKey` puts both of these on the same Redis key, so one
  // entry spends the other's budget.
  const outer = (): ThrottleLimit => ({
    kind: 'throttle',
    maxAttempts: 1,
    windowSeconds: 60,
    buildKey: (id: string) => `${PREFIX}:collide:${id}`,
  });
  const inner = (): ThrottleLimit => ({
    kind: 'throttle',
    maxAttempts: 1,
    windowSeconds: 60,
    buildKey: (id: string) => `${PREFIX}:collide:a:${id}`,
  });

  it('keeps two entries apart when one identifier contains the key delimiter', async () => {
    const first = await spend(outer(), 'a:b');

    const second = await spend(inner(), 'b');

    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second).toEqual({ allowed: true, count: 1 });
  });

  // An identifier that spells another one's percent-encoded form must not land
  // on its counter. `%` reaches a limiter id through percent-encoded values and
  // IPv6 zone indices (`fe80::1%eth0`); the keyed digest gives every distinct
  // identifier its own key.
  it('keeps a delimiter-bearing identifier apart from its own encoded spelling', async () => {
    const definition = throttle(1);

    const raw = await spend(definition, 'a:b');
    const spelled = await spend(definition, 'a%3Ab');

    expect(raw).toEqual({ allowed: true, count: 1 });
    expect(spelled).toEqual({ allowed: true, count: 1 });
  });

  it('resolves a delimiter-bearing identifier to its own stable key', async () => {
    const definition = throttle(1);
    const id = `2001:db8::1:${crypto.randomUUID()}`;

    const first = await spend(definition, id);
    const second = await spend(definition, id);

    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second.allowed).toBe(false);
  });

  it('clears a delimiter-bearing identifier', async () => {
    const definition = reservation(1);
    const id = `2001:db8::2:${crypto.randomUUID()}`;
    await spend(definition, id);

    const cleared = await clear(redis, definition, id);

    expect(cleared.isOk()).toBe(true);
    expect(await spend(definition, id)).toEqual({ allowed: true, count: 1 });
  });

  it('admits an identifier at the length bound', async () => {
    const definition = throttle(1);
    const id = 'i'.repeat(MAX_IDENTIFIER_LENGTH);
    createdKeys.push(keyOf(definition, id));

    expect(await spend(definition, id)).toEqual({ allowed: true, count: 1 });
  });

  it('refuses an identifier past the length bound', async () => {
    const decision = await consume(redis, throttle(1), 'i'.repeat(MAX_IDENTIFIER_LENGTH + 1));

    expect(decision._unsafeUnwrapErr().code).toBe('validation');
  });

  it('clears nothing for an identifier past the length bound, which counts nothing either', async () => {
    const cleared = await clear(redis, reservation(1), 'i'.repeat(MAX_IDENTIFIER_LENGTH + 1));

    expect(cleared.isOk()).toBe(true);
  });
});

describe('consume under concurrency', () => {
  it.each([1, 20, 50, 200])(
    'admits exactly the cap when %i calls race for it',
    async (concurrency) => {
      const cap = Math.max(1, Math.floor(concurrency / 2));
      const definition = throttle(cap);
      const id = freshId(definition);

      const decisions = await Promise.all(
        Array.from({ length: concurrency }, () => consume(redis, definition, id))
      );

      const admitted = decisions.filter((decision) => decision._unsafeUnwrap().allowed).length;
      expect(admitted).toBe(Math.min(cap, concurrency));
    }
  );
});

describe('consume round trips', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('issues exactly one request per check once the script is cached', async () => {
    const definition = throttle(1);
    const id = freshId(definition);
    // Warm Redis's script cache so EVALSHA hits and no EVAL fallback follows.
    await spend(definition, id);
    fetchSpy.mockClear();

    const refused = await spend(definition, id);

    expect(refused.allowed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('clear', () => {
  it('restarts the count for a reservation entry', async () => {
    const definition = reservation(1);
    const id = freshId(definition);
    await spend(definition, id);
    const refused = await spend(definition, id);

    const cleared = await clear(redis, definition, id);

    expect(refused.allowed).toBe(false);
    expect(cleared.isOk()).toBe(true);
    expect(await spend(definition, id)).toEqual({ allowed: true, count: 1 });
  });

  it('absorbs an unreachable Redis rather than failing the operation that succeeded', async () => {
    const cleared = await clear(unreachableRedis, reservation(1), crypto.randomUUID());

    expect(cleared.isOk()).toBe(true);
  });

  it('answers once the bound elapses rather than waiting on the delete', async () => {
    await buildTimeoutPolicy();
    vi.useFakeTimers();
    const observed = clear(neverDeleting, reservation(1), crypto.randomUUID()).match(
      () => 'answered',
      () => 'failed'
    );

    await vi.advanceTimersByTimeAsync(rateLimitBound().timeoutMs);
    await vi.advanceTimersToNextTimerAsync();

    expect(await observed).toBe('answered');
  });

  it('cannot be reached by a throttle entry', async () => {
    const definition = throttle(1);
    const id = freshId(definition);

    // @ts-expect-error a throttle never clears — the two limiter classes differ
    // only in the counter's lifecycle, and the type is what enforces it.
    const cleared = await clear(redis, definition, id);

    expect(cleared.isOk()).toBe(true);
  });
});
