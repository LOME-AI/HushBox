import type { Redis } from '@upstash/redis';

/**
 * A Redis double for the rate-limit primitive's single round trip. It records
 * the key each check builds and answers with a SCRIPTED reply rather than
 * counting: the counting itself is proven against real Redis in
 * `lib/rate-limit/consume.integration.test.ts`, and a double that re-derived a
 * verdict here would be a second implementation of the one algorithm — the
 * thing this migration exists to remove. What these doubles are for is the
 * half real Redis cannot show cheaply: which IDENTIFIER a caller is counted
 * under, and what a middleware does with a given decision.
 */
interface RateLimitDouble {
  readonly redis: Redis;
  /** Every counter key touched, in call order. A skipped layer adds none. */
  readonly keys: string[];
}

/**
 * Answers each check with the next scripted reply, repeating the last one once
 * the script runs out (so a test states only the replies it cares about).
 * Replies are the primitive's wire form,
 * `<verdict>:<refusingLayer>:<count>:<retryAfterSeconds>`, where the layer is
 * 1-based and zero on the admitted arm.
 */
export function scriptedRateLimitRedis(
  replies: readonly string[] = ['allowed:0:1:0']
): RateLimitDouble {
  const keys: string[] = [];
  let call = 0;
  const redis = {
    createScript: () => ({
      exec: (scriptKeys: string[]) => {
        keys.push(...scriptKeys);
        const reply = replies[Math.min(call, replies.length - 1)];
        call += 1;
        return Promise.resolve(reply);
      },
    }),
  } as unknown as Redis;
  return { redis, keys };
}

/** A Redis whose script call always fails — the fail-closed path. */
export function unreachableRateLimitRedis(): Redis {
  return {
    createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
  } as unknown as Redis;
}
