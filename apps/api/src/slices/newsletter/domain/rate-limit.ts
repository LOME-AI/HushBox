import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * Per-IP cap on UNAUTHENTICATED public newsletter signup — each request can
 * trigger an outbound confirmation email, so this is an abuse throttle, not a
 * secret-guessing reservation: nothing clears it. Counted at the edge by the
 * pipeline rate-limit stage, under the `ip` identity this slice's posture
 * fragment declares for `POST /newsletter/subscribe`. The DB-side
 * per-address resend throttle bounds mail volume per target independently.
 */
export const newsletterSubscribeIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 10,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:newsletter:subscribe:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * Per-IP cap on the public token-consumption endpoints, mirroring identity's
 * `verifyEmailIpRateLimit` (30/hour): the token itself is the credential, so
 * this is abuse-cost bounding on probing, not a secret-guessing reservation.
 * One key per route (the identity precedent), same values on both.
 */
export const newsletterConfirmIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:newsletter:confirm:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

export const newsletterUnsubscribeIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:newsletter:unsubscribe:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
