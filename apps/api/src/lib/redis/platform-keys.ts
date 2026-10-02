import type { ThrottleLimit } from '../rate-limit/index.js';

/**
 * Redis entries for the two unauthenticated public reads —
 * `apps/api/src/slices/roadmap/` and `apps/api/src/slices/stats/`, which reach
 * them through their own domain barrels. They live beside the mechanism rather
 * than in either slice, the same placement as `REALTIME_REDIS_KEYS`.
 */

/**
 * Per-IP cap on the UNAUTHENTICATED public roadmap endpoint. 30/60s mirrors
 * the public share-read cap; a marketing roadmap page does not refresh that
 * frequently in normal use.
 */
export const roadmapIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:platform:roadmap:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * Per-IP cap on the UNAUTHENTICATED public usage-stats endpoint. Same
 * rationale as `roadmapIpRateLimit`.
 */
export const statsIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:platform:stats:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
