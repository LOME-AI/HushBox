import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The per-address cap on the UNAUTHENTICATED beacon. An abuse throttle, not a
 * secret-guessing reservation: it guards nothing guessable and nothing clears
 * it.
 *
 * 120 a minute is two a second per address, which is well above what a reader
 * moving through a marketing site produces — a page view, a handful of clicks
 * and four scroll thresholds per page — and deliberately loose enough for an
 * office behind one egress address. Sixty was rejected on exactly that: a
 * shared address is the normal case here, not the abusive one.
 */
export const growthBeaconIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:growth:beacon:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
