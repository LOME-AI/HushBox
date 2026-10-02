import { Redis } from '@upstash/redis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { consume, consumeLayers, rateLimitKey } from './index.js';
import { rateLimitBound } from './bound.js';
import { MAX_IDENTIFIER_LENGTH } from './consume.js';
import type { RateLimitLayer } from './index.js';
import type { ThrottleLimit } from './index.js';

/**
 * The layered consume against real Redis. A layered check is all-or-nothing —
 * a request refused by one layer must leave every other layer's counter
 * untouched — while the refusing layer itself must keep advancing past its
 * cap, because a caller notifying on the crossing attempt reads that count.
 * Those two properties pull in opposite directions, which is why each is
 * asserted on the counters themselves rather than on the decision.
 */

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for rate-limit integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** A Redis whose script call never settles, so only the bound can end the wait. */
const neverAnswering = {
  createScript: () => ({ exec: () => new Promise<string>(() => {}) }),
} as unknown as Redis;

/** A Redis whose script call answers at once — enough to build the timeout policy. */
const answersAtOnce = {
  createScript: () => ({ exec: () => Promise.resolve('allowed:1:1:0') }),
} as unknown as Redis;

/**
 * A Redis whose script call outruns the bound and then lands: it waits
 * `afterMs`, records that it got there, and answers a well-formed reply. The
 * never-answering stub cannot tell an abandoned call still in flight from a
 * cancelled one, because it never gets anywhere under either.
 */
function landsAfter(afterMs: number): { readonly redis: Redis; readonly landed: () => boolean } {
  let landed = false;
  return {
    redis: {
      createScript: () => ({
        exec: async (): Promise<string> => {
          await new Promise((resolve) => setTimeout(resolve, afterMs));
          landed = true;
          return 'allowed:1:1:0';
        },
      }),
    } as unknown as Redis,
    landed: () => landed,
  };
}

const PREFIX = `test:rate-limit-layered:${crypto.randomUUID()}`;
const createdKeys: string[] = [];

function throttle(name: string, maxAttempts: number, windowSeconds = 60): ThrottleLimit {
  return {
    kind: 'throttle',
    maxAttempts,
    windowSeconds,
    buildKey: (id: string) => `${PREFIX}:${name}:${id}`,
  };
}

/** A layer on a counter no other test touches. */
function layer(definition: ThrottleLimit, id = crypto.randomUUID()): RateLimitLayer {
  const entry = { definition, id };
  createdKeys.push(keyOf(entry));
  return entry;
}

function keyOf(entry: RateLimitLayer): string {
  return rateLimitKey(entry.definition, entry.id)._unsafeUnwrap();
}

function countAt(entry: RateLimitLayer): Promise<number | null> {
  return redis.get<number>(keyOf(entry));
}

/** Puts a layer exactly at its cap, so the next attempt on it is the crossing one. */
async function seedToCap(entry: RateLimitLayer): Promise<void> {
  await redis.set(keyOf(entry), entry.definition.maxAttempts, {
    ex: entry.definition.windowSeconds,
  });
}

/** One layered check, unwrapped — for the arrangement steps a test does not assert on. */
async function arrange(layers: readonly RateLimitLayer[]): Promise<void> {
  const decision = await consumeLayers(redis, layers);
  decision._unsafeUnwrap();
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
  const built = await consumeLayers(answersAtOnce, [
    { definition: throttle('policy-build', 1), id: 'build' },
  ]);
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

describe('consumeLayers', () => {
  it('admits and counts every layer when none refuses', async () => {
    const first = layer(throttle('admit-a', 5));
    const second = layer(throttle('admit-b', 5));

    const decision = await consumeLayers(redis, [first, second]);

    expect(decision._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
    expect(await countAt(first)).toBe(1);
    expect(await countAt(second)).toBe(1);
  });

  it('reports the highest layer count on the admitted arm', async () => {
    const spent = layer(throttle('highest-a', 5));
    const fresh = layer(throttle('highest-b', 5));
    await arrange([spent, fresh]);
    await arrange([spent, layer(throttle('highest-b', 5))]);

    const decision = await consumeLayers(redis, [spent, fresh]);

    expect(decision._unsafeUnwrap()).toEqual({ allowed: true, count: 3 });
  });

  it('leaves an admitting layer untouched when a sibling refuses', async () => {
    const admitting = layer(throttle('all-or-nothing-a', 5));
    const capped = layer(throttle('all-or-nothing-b', 2));
    await seedToCap(capped);

    const decision = await consumeLayers(redis, [admitting, capped]);

    expect(decision._unsafeUnwrap().allowed).toBe(false);
    expect(await countAt(admitting)).toBeNull();
  });

  it('keeps the refusing layer advancing past its cap', async () => {
    const admitting = layer(throttle('crossing-a', 5));
    const capped = layer(throttle('crossing-b', 2));
    await seedToCap(capped);

    await arrange([admitting, capped]);
    await arrange([admitting, capped]);

    expect(await countAt(capped)).toBe(capped.definition.maxAttempts + 2);
  });

  it('reports the crossing count of the refusing layer, not of its siblings', async () => {
    const admitting = layer(throttle('crossing-count-a', 5));
    const capped = layer(throttle('crossing-count-b', 2));
    await seedToCap(capped);

    const decision = await consumeLayers(redis, [admitting, capped]);

    const value = decision._unsafeUnwrap();
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.count).toBe(capped.definition.maxAttempts + 1);
  });

  it('names the refusing layer by its position in the call', async () => {
    const admitting = layer(throttle('which-layer-a', 5));
    const capped = layer(throttle('which-layer-b', 2));
    await seedToCap(capped);

    const decision = await consumeLayers(redis, [admitting, capped]);

    const value = decision._unsafeUnwrap();
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.layer).toBe(1);
  });

  it('names the first refusing layer and advances every refusing one', async () => {
    const firstCapped = layer(throttle('both-refuse-a', 2));
    const secondCapped = layer(throttle('both-refuse-b', 3));
    await seedToCap(firstCapped);
    await seedToCap(secondCapped);

    const decision = await consumeLayers(redis, [firstCapped, secondCapped]);

    const value = decision._unsafeUnwrap();
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.layer).toBe(0);
    expect(await countAt(firstCapped)).toBe(firstCapped.definition.maxAttempts + 1);
    expect(await countAt(secondCapped)).toBe(secondCapped.definition.maxAttempts + 1);
  });

  it('answers the refusing layer own retry-after', async () => {
    const admitting = layer(throttle('retry-after-a', 5, 90));
    const capped = layer(throttle('retry-after-b', 2, 45));
    await seedToCap(capped);

    const decision = await consumeLayers(redis, [admitting, capped]);

    const value = decision._unsafeUnwrap();
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.retryAfterSeconds).toBeGreaterThan(0);
    expect(value.retryAfterSeconds).toBeLessThanOrEqual(45);
  });

  it('anchors each layer own window at its own length', async () => {
    const short = layer(throttle('window-a', 5, 30));
    const long = layer(throttle('window-b', 5, 120));

    await arrange([short, long]);

    expect(await redis.ttl(keyOf(short))).toBeGreaterThan(0);
    expect(await redis.ttl(keyOf(short))).toBeLessThanOrEqual(30);
    expect(await redis.ttl(keyOf(long))).toBeGreaterThan(30);
  });

  it('costs one Redis round trip whatever the layer count', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const layers = [
      layer(throttle('round-trip-a', 5)),
      layer(throttle('round-trip-b', 5)),
      layer(throttle('round-trip-c', 5)),
    ];
    fetchSpy.mockClear();

    await arrange(layers);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('decides a single layer exactly as consume does', async () => {
    const only = layer(throttle('degenerate', 2));

    const first = await consumeLayers(redis, [only]);
    const second = await consume(redis, only.definition, only.id);
    const third = await consumeLayers(redis, [only]);

    expect(first._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
    expect(second._unsafeUnwrap()).toEqual({ allowed: true, count: 2 });
    const refused = third._unsafeUnwrap();
    if (refused.allowed) throw new Error('expected a refusal');
    expect(refused.count).toBe(3);
    expect(refused.layer).toBe(0);
  });

  it('fails closed when Redis is unreachable', async () => {
    const unreachable = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

    const decision = await consumeLayers(unreachable, [layer(throttle('unreachable', 5))]);

    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails closed when a counter never answers, once the bound elapses', async () => {
    await buildTimeoutPolicy();
    vi.useFakeTimers();
    const observed = consumeLayers(neverAnswering, [layer(throttle('never-answers', 5))]).match(
      () => 'admitted',
      (error) => error.code
    );

    await vi.advanceTimersByTimeAsync(rateLimitBound().timeoutMs);
    await vi.advanceTimersToNextTimerAsync();

    expect(await observed).toBe('unavailable');
  });

  it('leaves the check waiting until the bound elapses', async () => {
    await buildTimeoutPolicy();
    vi.useFakeTimers();
    let outcome: string | undefined;
    const observed = (async (): Promise<void> => {
      outcome = await consumeLayers(neverAnswering, [layer(throttle('still-waiting', 5))]).match(
        () => 'admitted',
        (error) => error.code
      );
    })();

    await vi.advanceTimersByTimeAsync(rateLimitBound().timeoutMs - 1);

    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    await observed;
  });

  /**
   * The clause an operator's conclusion rests on during a degradation: a check
   * that outruns the bound has its WAIT abandoned, not its call cancelled, so
   * against a Redis that is slow rather than gone the attempt is still spent
   * while the caller is told only `unavailable`. {@link neverAnswering} cannot
   * show this — a call that never lands looks identical cancelled or not.
   *
   * The honest limit: the endpoint here is a stub, so this pins the policy's
   * non-cancellation and NOT that Upstash incremented a counter. No local test
   * can prove the latter, because proving it needs an endpoint that is slow and
   * real at once.
   */
  it('abandons the wait on an outrunning check without cancelling the call', async () => {
    await buildTimeoutPolicy();
    const boundMs = rateLimitBound().timeoutMs;
    const late = landsAfter(boundMs * 2);
    vi.useFakeTimers();
    const observed = consumeLayers(late.redis, [layer(throttle('lands-late', 5))]).match(
      () => 'admitted',
      (error) => error.code
    );

    await vi.advanceTimersByTimeAsync(boundMs);
    await vi.advanceTimersToNextTimerAsync();

    expect(await observed).toBe('unavailable');
    expect(late.landed()).toBe(false);

    await vi.advanceTimersByTimeAsync(boundMs);

    expect(late.landed()).toBe(true);
  });

  it('fails closed when any layer carries a non-positive window', async () => {
    const decision = await consumeLayers(redis, [
      layer(throttle('bad-window-a', 5)),
      layer(throttle('bad-window-b', 5, 0)),
    ]);

    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails closed when any layer carries a fractional window', async () => {
    const decision = await consumeLayers(redis, [layer(throttle('fractional-window', 5, 1.5))]);

    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('refuses when any layer carries a cap of zero', async () => {
    const zeroCapped = layer(throttle('zero-cap', 0));

    const decision = await consumeLayers(redis, [
      layer(throttle('zero-cap-sibling', 5)),
      zeroCapped,
    ]);

    const value = decision._unsafeUnwrap();
    if (value.allowed) throw new Error('expected a refusal');
    expect(value.layer).toBe(1);
  });

  it('refuses when any layer carries a NaN cap', async () => {
    // Every comparison against NaN is false, so the natural `spent + 1 > cap`
    // spelling would read this cap as room to spare and admit without bound.
    const decision = await consumeLayers(redis, [layer(throttle('nan-cap', Number.NaN))]);

    expect(decision._unsafeUnwrap().allowed).toBe(false);
  });

  it('fails closed when a stored counter is not a number', async () => {
    const corrupt = layer(throttle('corrupt-counter', 5));
    await redis.set(keyOf(corrupt), 'not-a-number', { ex: 60 });

    const decision = await consumeLayers(redis, [corrupt]);

    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('refuses when any layer identifier passes the length bound', async () => {
    const decision = await consumeLayers(redis, [
      layer(throttle('long-id-a', 5)),
      { definition: throttle('long-id-b', 5), id: 'i'.repeat(MAX_IDENTIFIER_LENGTH + 1) },
    ]);

    expect(decision._unsafeUnwrapErr().code).toBe('validation');
  });

  it('treats an empty layer list as a composition defect', () => {
    expect(() => consumeLayers(redis, [])).toThrow(/at least one layer/);
  });
});

describe('consumeLayers under concurrency', () => {
  it('leaves an admitting layer untouched by 40 racing refusals', async () => {
    const admitting = layer(throttle('race-admit', 1000));
    const capped = layer(throttle('race-capped', 2));
    await seedToCap(capped);

    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => consumeLayers(redis, [admitting, capped]))
    );

    expect(decisions.filter((decision) => decision._unsafeUnwrap().allowed)).toHaveLength(0);
    expect(await countAt(admitting)).toBeNull();
    expect(await countAt(capped)).toBe(capped.definition.maxAttempts + 40);
  });

  it('admits exactly the strictest cap when 40 layered calls race', async () => {
    const wide = layer(throttle('race-wide', 1000));
    const narrow = layer(throttle('race-narrow', 5));

    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => consumeLayers(redis, [wide, narrow]))
    );

    expect(decisions.filter((decision) => decision._unsafeUnwrap().allowed)).toHaveLength(5);
    expect(await countAt(wide)).toBe(5);
    expect(await countAt(narrow)).toBe(40);
  });
});
