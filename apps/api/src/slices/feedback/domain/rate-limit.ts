import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The per-caller cap on AUTHENTICATED feedback submission — the volume bound on
 * the `feedback` rows one caller writes. An abuse throttle, not a
 * secret-guessing reservation: nothing clears it. Counted at the edge by the
 * pipeline rate-limit stage, under the `caller` identity this slice's posture
 * fragment declares for `POST /feedback`, which is also where what these two
 * windows price is stated.
 */
export const feedbackSubmitRateLimit = {
  kind: 'throttle',
  maxAttempts: 10,
  windowSeconds: 60,
  buildKey: (callerId: string) => `ratelimit:feedback:submit:user:${callerId}`,
} as const satisfies ThrottleLimit;

/**
 * The hourly per-caller ceiling layered over the 10/min burst limiter: it bounds
 * sustained submission a burst window can't (ten every minute is 600/hour). A
 * second throttle; both apply on `POST /feedback` and either
 * tripping answers 429. `maxAttempts: 30/hour` is a chosen default — tunable.
 */
export const feedbackSubmitHourlyRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 3600,
  buildKey: (callerId: string) => `ratelimit:feedback:submit:user-hourly:${callerId}`,
} as const satisfies ThrottleLimit;
