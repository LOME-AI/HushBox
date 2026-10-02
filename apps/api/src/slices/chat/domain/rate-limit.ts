import { consume } from '../../../lib/rate-limit/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitDecision, ThrottleLimit } from '../../../lib/rate-limit/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The chat slice's rate-limit registry entries that live here. None of them
 * guards a guessable secret and nothing clears them on success, so every one is
 * a throttle. The slice's remaining entries — the trial 5/day quota's
 * per-session and per-IP counters — sit in `trial/quota.ts` beside the UTC-day
 * scoping their keys carry and nothing here needs; that is where they belong,
 * not a split to consolidate away.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/**
 * The paid chat send's throttle — 30 sends / 60s per key. One definition
 * mounted under two declared identities, so no single identity word describes
 * it. `$post /chat` and `$post /chat/regenerate` declare it `user`, counted at
 * the edge by the pipeline rate-limit stage before context resolution and turn
 * build. `$post /chat/guest` declares it `caller`, spent inside that route's
 * handler: it admits a link guest and a session holder alike, and only the
 * handler's server-side resolution knows which of the two a window belongs to.
 * The declarations are in `slices/chat/rate-limit-posture.ts`.
 */
export const CHAT_STREAM_USER_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 60,
  buildKey: (userId: string) => `ratelimit:chat:stream:user:${userId}`,
} as const satisfies ThrottleLimit;

/**
 * The guest send's per-IP abuse throttle — the credential is a link key rather
 * than a guessable secret, so nothing about it is a reservation. It bounds a
 * caller whose credential has not been resolved yet, which is the only thing
 * that can bound a flood of unresolvable ones; the per-sender window the
 * handler spends afterwards is untouched.
 *
 * Sized as a multiple of that per-sender cap, deliberately. Matching it would
 * put a single guest against both ceilings at the same moment, which buys
 * nothing and makes a second guest behind one NAT the first casualty; what this
 * window is here to bound is a flood of credentials that resolve to nothing. It
 * is spent ahead of body validation as well as ahead of that resolution, so what
 * it prices is admitted requests: a body the schema rejects is counted and
 * resolves nothing.
 */
export const CHAT_GUEST_SEND_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:chat:guest-send:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The run stop's per-IP abuse throttle. Stop carries its own window rather than
 * sharing the send's: a caller must stay able to abort a paid run after a burst
 * of sends has exhausted the send window, since the alternative is a run that
 * bills on while its stop is refused.
 */
export const CHAT_STOP_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:chat:stop:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The trial send's per-IP abuse throttle. The model gate reads Postgres before
 * the quota is consumed and a refusal deliberately burns no quota slot, so
 * without a bound ahead of that read an anonymous caller drives one query per
 * request indefinitely; this window is that bound.
 *
 * Sized far above legitimate trial use (five messages a day) on purpose. What a
 * real caller meets is the quota; what this bounds is a refusal path a real
 * caller never repeats, and matching the two ceilings would only make a second
 * trial user behind one NAT the first casualty.
 */
export const CHAT_TRIAL_SEND_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:chat:trial-send:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The trial remaining-count read's per-IP abuse throttle. It carries its own
 * window rather than sharing the send's: a composer polling the count must
 * never be able to spend the budget that bounds sends, and a caller who has
 * exhausted the send window must still be able to see why.
 *
 * Sized like its siblings — far above what a composer asks for, low enough that
 * the read cannot be driven as a Redis amplifier by an anonymous caller.
 */
export const CHAT_TRIAL_REMAINING_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 120,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:chat:trial-remaining:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * The trial websocket upgrade's per-IP abuse throttle. The trial's SEND path
 * is quota-gated; the UPGRADE is not, so without this an anonymous caller mints
 * Durable Object connections without bound. The window is spent ahead of the
 * handler, so what it prices is admitted requests: a principal the handler
 * refuses and a replay declaration the realtime port rejects are each counted
 * and each mint nothing.
 *
 * Counted for every caller rather than sessionless ones only: the handler
 * refuses every non-`none` principal before the upgrade, so the sessionless
 * carve-out is vacuous here and counting everyone is the conservative default.
 *
 * Sized below its siblings because the legitimate shape is far smaller: a
 * trial caller opens one connection per session and reconnects on drop, where
 * the send and remaining-count windows absorb per-message traffic.
 */
export const CHAT_TRIAL_WEBSOCKET_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: 30,
  windowSeconds: 60,
  buildKey: (ipHash: string) => `ratelimit:chat:trial-websocket:ip:${ipHash}`,
} as const satisfies ThrottleLimit;

/**
 * Spends one paid chat send before context resolution, under the sender
 * identifier it is given — a link id for a link guest, an account id for a
 * session holder.
 */
export function consumeChatStreamUserLimit(
  redis: RedisClient,
  userId: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consume(redis, CHAT_STREAM_USER_RATE_LIMIT, userId);
}

/**
 * Counts one trial send against its IP window, before the route's first
 * Postgres read. A throttle: the counter guards no guessable secret, and
 * nothing clears it on a successful send — the window opens at the first
 * attempt and expires on its own.
 */
export function consumeTrialSendIpLimit(
  redis: RedisClient,
  ipHash: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consume(redis, CHAT_TRIAL_SEND_IP_RATE_LIMIT, ipHash);
}

/** Counts one trial remaining-count read against its IP window, before the quota is read. */
export function consumeTrialRemainingIpLimit(
  redis: RedisClient,
  ipHash: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consume(redis, CHAT_TRIAL_REMAINING_IP_RATE_LIMIT, ipHash);
}
