import { describe, it, expect } from 'vitest';
import { Redis } from '@upstash/redis';

/**
 * Validates the platform assumption the class-default bypass report rests on.
 * A Worker's clock is frozen between I/O operations, so `Date.now()` returning
 * the same instant for an isolate's whole life would turn the report's window
 * into a permanent mute: the isolate would report the first outage it met and
 * nothing afterwards, which is the failure the window exists to avoid. The
 * counter call that fails is itself network I/O, and that is what moves the
 * clock. Node's clock advances unconditionally, so the assertion is only
 * meaningful inside the runtime the Worker runs on.
 */
const UNREACHABLE_REDIS = 'http://127.0.0.1:1';

/**
 * A command whose rejection the client fully observes. The counter spends its
 * attempt through `Redis.createScript(...).exec(...)`, which against an
 * unreachable endpoint leaves one rejection unobserved inside the library —
 * noise this test would inherit and nothing it is asserting. What is asserted
 * is a property of the failed HTTP round trip, which both commands make
 * identically.
 */
async function failedRedisCall(redis: Redis): Promise<void> {
  await expect(redis.get('rate-limit-clock-probe')).rejects.toThrow();
}

/**
 * One failed round trip is usually enough; against a refused local connection
 * it can complete inside a single millisecond, and the loop is what keeps that
 * from reading as a frozen clock.
 */
const MAX_CALLS = 20;

describe('the clock a class-default bypass report is windowed on, under workerd', () => {
  it('runs on workerd, not on the node test runtime', () => {
    // Guards the guard: under node this file would assert a property the
    // Worker runtime does not necessarily have.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('advances Date.now across counter calls that cannot reach Redis', async () => {
    const redis = new Redis({ url: UNREACHABLE_REDIS, token: 'unused', retry: false });
    const before = Date.now();
    let after = before;

    for (let call = 0; call < MAX_CALLS && after === before; call += 1) {
      await failedRedisCall(redis);
      after = Date.now();
    }

    expect(after).toBeGreaterThan(before);
  });
});
