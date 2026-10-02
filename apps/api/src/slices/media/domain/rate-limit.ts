import { consume } from '../../../lib/rate-limit/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitDecision, ThrottleLimit } from '../../../lib/rate-limit/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The media slice's rate-limit registry entries.
 *
 * `mediaDownloadUserRateLimit` (per caller — the session userId, or for a
 * sessionless caller a hashed `ip:` stand-in, narrowed to `ip:…:link:…` when
 * a link credential is presented) and `sharePresignIpRateLimit` (per IP
 * on the unauthenticated share path) are counted at the edge by the pipeline
 * rate-limit stage, from the layers this slice's posture fragment declares for
 * the presign routes, mirroring the conversations slice's
 * `publicShareReadRateLimit`. Windows preserve the legacy registry's
 * values (presign minting 60/min per caller; the share IP cap mirrors the
 * public share read's 30/min).
 *
 * `mediaDownloadGuestIpRateLimit` is the member path's pre-resolution throttle,
 * also edge-enforced but counting only callers with no session — the ones whose
 * credential the handler must resolve against `shared_links`. The per-caller
 * window it sits in front of is keyed in part on that credential, which the
 * caller presents and can rotate, so N well-formed credentials from one address
 * open N of those windows rather than sharing one; this window bounds that. It
 * anchors on the IP identity, which is not rotatable per request because that
 * identity reduces an IPv6 caller to its /64. Sized at a multiple
 * of the per-caller cap rather than at it: a single guest meets the 60/min
 * window first, so this one only answers a caller spending credentials faster
 * than a real one does, and matching the two would instead make a second guest
 * of a different link behind one /64 the first casualty.
 *
 * `sharePresignRemintRateLimit` and `mediaDownloadLinkMintRateLimit` are the
 * two entries enforced HERE rather than at the edge, each because its
 * identifier only exists once the handler has resolved something.
 *
 * `sharePresignRemintRateLimit` is route-behavioral: a
 * shareId is an unauthenticated capability, so unlimited re-mints would let
 * one leaked share hammer the signing path and re-arm ciphertext URLs
 * indefinitely; the edge enforcer's per-IP cap does not bound a distributed
 * caller, the per-shareId counter does.
 *
 * The two `mediaDownloadLink*` entries are the member path's counterpart to that
 * cap, for the same reason: a link credential is a capability too, and every
 * other member-path window is per network, so one leaked link yields 240 lookups
 * and 60 signed URLs a minute PER NETWORK the attacker holds — linear in a count
 * nothing bounds. They are a pair because the two costs sit on opposite sides of
 * the credential resolution:
 *
 * - `mediaDownloadLinkLookupRateLimit` bounds the `shared_links` resolutions one
 *   link can buy. It must be spent before the resolution, so it is keyed on the
 *   canonicalized credential (the link's auth token — one link, one token)
 *   rather than on the `linkId` the resolution would return.
 * - `mediaDownloadLinkMintRateLimit` bounds the signed URLs and the
 *   authorization reads behind them, keyed on the resolved `linkId` — the link's
 *   real identity, which the handler has by then.
 *
 * The mint cap is sized at 20 saturated per-caller windows (1200/min). One
 * guest's legitimate ceiling is already the 60/min per-caller cap, so the only
 * judgement left is how many guests of ONE link can plausibly be active in the
 * same minute: a link credential admits a conversation participant, so its
 * audience is a group a person deliberately invited, not a broadcast audience —
 * the broadcast surface is the share route, whose global cap is 30/min. Twenty
 * simultaneously saturating guests is taken as the legitimate ceiling; a
 * genuinely popular link degrading for every guest at once is the cost being
 * bought down, so the cap sits well above plausible use rather than near it.
 *
 * The lookup cap is that mint cap times the same multiple the per-network pair
 * already uses (240/60), i.e. 4800/min, and for the identical reason recorded
 * there: a legitimate link meets its mint cap first, so this window only ever
 * answers a caller spending resolutions faster than mints — which is what a
 * caller refused downstream, or presenting a revoked link, does.
 */

/**
 * The per-request Redis client as the pipeline types it — named here because
 * this `domain/` layer is refused the infra module itself. Which layers the ban
 * covers is stated in `packages/config/eslint-extensions/boundaries.config.mjs`.
 */
type RedisClient = Variables['redis'];

export const MEDIA_RATE_LIMITS = {
  mediaDownloadUserRateLimit: {
    kind: 'throttle',
    maxAttempts: 60,
    windowSeconds: 60,
    buildKey: (callerId: string) => `ratelimit:media:download:user:${callerId}`,
  } as const satisfies ThrottleLimit,
  mediaDownloadGuestIpRateLimit: {
    kind: 'throttle',
    maxAttempts: 240,
    windowSeconds: 60,
    buildKey: (ipHash: string) => `ratelimit:media:download:guest-ip:${ipHash}`,
  } as const satisfies ThrottleLimit,
  mediaDownloadLinkMintRateLimit: {
    kind: 'throttle',
    maxAttempts: 1200,
    windowSeconds: 60,
    buildKey: (linkId: string) => `ratelimit:media:download:link-mint:${linkId}`,
  } as const satisfies ThrottleLimit,
  mediaDownloadLinkLookupRateLimit: {
    kind: 'throttle',
    maxAttempts: 4800,
    windowSeconds: 60,
    buildKey: (credentialHash: string) => `ratelimit:media:download:link-lookup:${credentialHash}`,
  } as const satisfies ThrottleLimit,
  sharePresignIpRateLimit: {
    kind: 'throttle',
    maxAttempts: 30,
    windowSeconds: 60,
    buildKey: (ipHash: string) => `ratelimit:media:share-presign:ip:${ipHash}`,
  } as const satisfies ThrottleLimit,
  sharePresignRemintRateLimit: {
    kind: 'throttle',
    maxAttempts: 30,
    windowSeconds: 60,
    buildKey: (shareId: string) => `ratelimit:media:share-presign:remint:${shareId}`,
  } as const satisfies ThrottleLimit,
} as const;

/** Spends one presign re-mint for the shareId before any authorization runs. */
export function reserveShareRemint(
  redis: RedisClient,
  shareId: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consume(redis, MEDIA_RATE_LIMITS.sharePresignRemintRateLimit, shareId);
}

/**
 * Spends one signed-URL mint against the resolved link's global window. Lives
 * here rather than at the edge because its identifier does not exist until the
 * handler has resolved the presented credential to a `linkId`.
 */
export function consumeLinkMint(
  redis: RedisClient,
  linkId: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consume(redis, MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit, linkId);
}
