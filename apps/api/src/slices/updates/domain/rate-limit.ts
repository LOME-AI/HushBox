import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The updates slice's rate-limit registry entry.
 *
 * A throttle, never a reservation: an address is not a secret being guessed,
 * and no outcome on this surface is a verified success that could clear the
 * counter.
 */

/**
 * Per-IP cap on the UNAUTHENTICATED bundle download. It is spent ahead of the
 * path-parameter check and the object lookup, so what it prices is admitted
 * requests: a platform the schema rejects and a request meeting no bucket
 * binding are each counted and each read nothing. What it exists to bound is the
 * request that does resolve — one naming a published bundle streams the whole
 * object out of R2, so the exposure is the compute and bandwidth the platform
 * bills for, not storage egress (R2 charges none), which is also why the
 * documented presigned-URL range-request amplification does not apply here.
 *
 * Counted for every caller rather than sessionless ones only: the bundle is
 * the same object whoever asks, so skipping signed-in callers would leave the
 * fetch this bounds unbounded for anyone holding a session. 60/60s is far
 * above the real shape — a client downloads one bundle per released version.
 */
export const bundleDownloadIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 60,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:updates:download:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
