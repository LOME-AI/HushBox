import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The per-IP abuse throttles on the unauthenticated auth surfaces. Each is
 * counted at the edge by the pipeline rate-limit stage, under the `ip`
 * identity this slice's posture fragment declares for its route.
 *
 * Legacy DUAL-limited the surfaces it covered (a per-IP dimension AND a second
 * dimension bounding the account or token a caller named); where it did, that
 * second dimension is the matching entry in `domain/keys.ts`, consumed inside
 * the domain flow and declared `claimed-account` in this slice's posture
 * fragment — `presented-token` for the verification-token entry, whose subject
 * is the token itself. The window here mirrors the legacy `*IpRateLimit`.
 *
 * Throttles, not reservations: an IP is not a secret being guessed, and
 * nothing clears these on any outcome.
 */

/** Login start, per IP (legacy `loginIpRateLimit`: 20 per 15 minutes). */
export const loginIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 900,
  buildKey: (ipHash: string) => `ratelimit:identity:login:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/** Registration start, per IP (legacy `registerIpRateLimit`: 10 per hour). */
export const registerIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 10,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:identity:register:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/** Recovery reset start, per IP (legacy `recoveryIpRateLimit`: 10 per hour). */
export const recoveryResetIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 10,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:identity:recovery-reset:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * Recovery wrapped-key retrieval, per IP (legacy `recoveryGetKeyIpRateLimit`:
 * 10 per hour).
 */
export const recoveryGetKeyIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 10,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:identity:recovery-getkey:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/** Email-verification token consume, per IP (legacy `verifyIpRateLimit`: 30 per hour). */
export const verifyEmailIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 3600,
  buildKey: (ipHash: string) => `ratelimit:identity:verify-email:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/** Verification-email resend, per IP (legacy `resendVerifyIpRateLimit`: 5 per 60s). */
export const resendVerifyIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 5,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:identity:resend-verify:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * Billing-portal token redemption, per IP (20 per 10 minutes). No legacy
 * counterpart, and no paired second dimension: the credential is the token
 * in the body, and keying a window on the account that token names would hand
 * an attacker a lockout lever over that account. Sized to stop enumeration
 * rather than ration use — the token is a server-minted 122-bit-random uuid
 * alive for 60 seconds, and a corporate NAT can put many legitimate handoffs
 * behind one address.
 */
export const tokenLoginIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 600,
  buildKey: (ipHash: string) => `ratelimit:identity:token-login:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
