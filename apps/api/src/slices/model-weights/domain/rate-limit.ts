import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The model-weights slice's rate-limit registry entry.
 *
 * A throttle, never a reservation: an address is not a secret being guessed,
 * and no outcome on this surface is a verified success that could clear the
 * counter.
 */

/**
 * Per-IP cap on the UNAUTHENTICATED artifact download. It is spent ahead of the
 * path-parameter check and the object lookup, so what it prices is admitted
 * requests: a segment the schema rejects and a request meeting no bucket binding
 * are each counted and each read nothing. What it exists to bound is the request
 * that does resolve — one naming a published artifact streams the whole object
 * out of the Worker, and a weights file is the largest body this API serves, so
 * the exposure is the compute and bandwidth the platform bills for.
 *
 * Counted for every caller rather than sessionless ones only: the artifact is
 * the same object whoever asks, so skipping signed-in callers would leave the
 * fetch this bounds unbounded for anyone holding a session. 60/60s is far above
 * the real shape — a client fetches a handful of files once per model version,
 * and every later fetch is served from cache without reaching the Worker.
 */
export const modelArtifactDownloadIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 60,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:model-weights:download:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
