import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

/**
 * The per-IP cap on the UNAUTHENTICATED public share read endpoint, throttling
 * link-id scraping. Counted at the edge by the pipeline rate-limit stage,
 * under the `ip` identity this slice's posture fragment declares for the
 * share-read path. Window mirrors the legacy `shareGetIpRateLimit`.
 */
export const publicShareReadRateLimit = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:conversations:share-read:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The per-IP cap on the guest-reachable conversation routes — the reads and the
 * socket-ticket mint a link guest reaches with its link credential, and the
 * realtime upgrade it opens with the single-use ticket that mint issued. One
 * window spans them all because they are the steps of one guest's open: every
 * credential-bearing route answers the credential with the same `shared_links`
 * lookup, and the upgrade spends a ticket one of those lookups paid for. It
 * counts only callers with no session; the window is sized for a guest opening
 * a conversation (roughly ten of these routes per open) rather than for one
 * request at a time.
 */
export const guestConversationIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:conversations:guest:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The per-caller cap on AUTHENTICATED shared-message creation — the volume bound
 * on the `shared_messages` rows one caller inserts. Counted at the edge by the
 * pipeline rate-limit stage, under the `caller` identity this slice's posture
 * fragment declares for the create path (keyed by userId for a full principal);
 * the window mirrors the legacy `shareCreateUserRateLimit`.
 */
export const shareCreateRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 60,
  buildKey: (callerId: string) => `ratelimit:conversations:share-create:user:${callerId}`,
} as const satisfies ThrottleLimit;

/**
 * The per-user cap on AUTHENTICATED shared-link minting. It is the volume bound
 * on the `shared_links` rows a mint inserts and the guest member each one seats:
 * a link that has lapsed or been revoked occupies no member slot, so the
 * conversation member cap stops the mint loop only while the links stay live,
 * and nothing else counts a dead seat. Counted at the edge by the pipeline
 * rate-limit stage, under the `user` identity this slice's posture fragment
 * declares for the mint (a session-class route, so the caller is always a full
 * principal). Sized like the shared-message create window beside
 * it: minting is a deliberate one-at-a-time act in the invite UI, so twenty in a
 * minute is far above the flow and far below a loop.
 */
export const linkCreateRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 60,
  buildKey: (callerId: string) => `ratelimit:conversations:link-create:user:${callerId}`,
} as const satisfies ThrottleLimit;

/**
 * The per-account cap on the batch keychain read — the most database-expensive
 * authenticated read the slice answers, and the one an account can replay
 * cheaply. Counted at the edge by the pipeline rate-limit stage, under the
 * `user` identity this slice's posture fragment declares for the batch path
 * (a session-class route, so the caller is always a full principal).
 *
 * Sized above any real cold launch rather than close to it: a launch issues one
 * request per page of the conversation list, and the query schema caps a page
 * at a hundred ids, so this window covers six thousand conversations a minute
 * — while holding the endpoint's total cost to a bounded number of set-based
 * reads per account per minute.
 */
export const memberKeysBatchRateLimit = {
  kind: 'throttle',
  maxAttempts: 60,
  windowSeconds: 60,
  buildKey: (callerId: string) => `ratelimit:conversations:member-keys:user:${callerId}`,
} as const satisfies ThrottleLimit;
