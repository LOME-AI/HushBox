import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The models slice's rate-limit registry entry.
 *
 * A throttle, never a reservation: an address is not a secret being guessed,
 * and no outcome on this surface is a verified success that could clear the
 * counter.
 */

/**
 * Per-IP cap on the UNAUTHENTICATED catalog list. Every request that reaches
 * the origin costs one catalog read against Postgres, and the route is
 * reachable before login — so without this an anonymous caller buys unbounded
 * database work.
 *
 * Counted for every caller rather than sessionless ones only: the read is
 * identical whoever asks, so a window that skipped signed-in callers would
 * leave the exact cost this bounds unbounded for anyone holding a session.
 * The client's own use is far below it — the picker caches the catalog for an
 * hour, so one load per app session is the real shape.
 *
 * Sized against the E2E suite, measured issuing 144 catalog reads within one
 * window across a whole project. That project's workers no longer share one
 * address — the suite's caller identity carries a worker-slot axis
 * (`scripts/lib/playwright/identities.ts`) — so the measurement is an upper
 * bound spread over a project's workers rather than one window's spend, and
 * the figure holds with headroom while still bounding a single-source flood.
 */
export const catalogListIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 300,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:models:catalog:ip:${ipHash}`,
} as const satisfies ThrottleLimit;
