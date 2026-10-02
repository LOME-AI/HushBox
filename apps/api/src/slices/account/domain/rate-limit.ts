import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The per-user cap on username search. An abuse throttle, not a
 * secret-guessing reservation: nothing clears it, and it reserves nothing a
 * successful search hands back. The surface it guards is not a secret — the
 * gate on it (membership of the named conversation) is satisfiable by any
 * session user, who need only create a conversation first, so the search is
 * reachable by everyone and bounded by nothing else.
 *
 * 60 per minute is above any human rate through the only client that calls it:
 * the invite box issues one request per distinct prefix as the operator types,
 * undebounced, and caches repeats. It bounds a scripted caller to one query per
 * second against `users`.
 *
 * Counted at the edge by the pipeline rate-limit stage, under the `user`
 * identity this slice's posture fragment declares for
 * `GET /account/users/search`.
 */
export const userSearchRateLimit = {
  kind: 'throttle',
  maxAttempts: 60,
  windowSeconds: 60,
  buildKey: (userId: string) => `ratelimit:account:user-search:user:${userId}`,
} as const satisfies ThrottleLimit;
