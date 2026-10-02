import { getIronSession } from 'iron-session';
import { match } from 'ts-pattern';
import { billingPortalCookieOptions, sessionCookieOptions } from '../../../../lib/context/index.js';
import { fromPromise, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { redisDel, redisSet } from '../../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import type { BillingPortalClaims, SessionClaims } from '../../../../lib/context/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { EvictUserPort } from '../../ports/index.js';
import type { RedisClient } from '../keys.js';

/** Legacy-compatible window for completing the TOTP challenge after login. */
export const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

/**
 * The two login-session shapes this slice issues, both from the login flow.
 * The billing-portal handoff is NOT one of them: it is a credential of its own,
 * with its own cookie and its own active key
 * ({@link issueBillingPortalCredential}).
 */
export type SessionKind = 'full' | 'pending-2fa';

interface IssueSessionArgs {
  readonly request: Request;
  readonly response: Response;
  readonly redis: RedisClient;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly userId: string;
  readonly kind: SessionKind;
  readonly now: number;
  /** Caller-provided session id; omitted → fresh uuid. */
  readonly sessionId?: string;
}

interface DestroyCookieArgs {
  readonly request: Request;
  readonly response: Response;
  readonly secret: string;
  readonly isProduction: boolean;
}

function buildClaims(
  userId: string,
  sessionId: string,
  kind: SessionKind,
  now: number
): SessionClaims {
  const base = { userId, sessionId, createdAt: now };
  return match(kind)
    .with('full', () => ({ ...base, pending2FA: false, pending2FAExpiresAt: 0 }))
    .with('pending-2fa', () => ({
      ...base,
      pending2FA: true,
      pending2FAExpiresAt: now + PENDING_2FA_TTL_MS,
    }))
    .exhaustive();
}

function sealCookie(
  args: IssueSessionArgs,
  claims: SessionClaims,
  sessionId: string
): ResultAsync<{ sessionId: string }, DomainError> {
  return fromPromise(
    (async (): Promise<{ sessionId: string }> => {
      const session = await getIronSession<SessionClaims>(
        args.request,
        args.response,
        sessionCookieOptions(args.secret, args.isProduction)
      );
      Object.assign(session, claims);
      await session.save();
      return { sessionId };
    })(),
    (cause) => unavailableError('session cookie sealing failed', cause)
  );
}

/**
 * Session issuance over the sealed cookie + sessionActive key. Order is
 * load-bearing: the sessionActive key is written BEFORE the cookie is
 * sealed, so a failure can never hand the client a cookie the revocation
 * check would immediately reject — and a crash between the two leaves only
 * an expiring Redis key, nothing else.
 */
export function issueSession(
  args: IssueSessionArgs
): ResultAsync<{ readonly sessionId: string }, DomainError> {
  const sessionId = args.sessionId ?? crypto.randomUUID();
  const claims = buildClaims(args.userId, sessionId, args.kind, args.now);
  return redisSet(args.redis, IDENTITY_KEYS.sessionActive, '1', args.userId, sessionId).andThen(
    () => sealCookie(args, claims, sessionId)
  );
}

interface IssueBillingPortalCredentialArgs {
  readonly request: Request;
  readonly response: Response;
  readonly redis: RedisClient;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly userId: string;
  /**
   * Derived deterministically from the one-time login token by the caller, so
   * every redemption of one token converges on ONE credential — the same active
   * key, the same claims, no orphans under replays or races.
   */
  readonly sessionId: string;
  readonly now: number;
}

/**
 * Issues the mobile → web billing-portal credential: its own cookie, its own
 * active key, and no login cookie anywhere on the response. The write order is
 * the one {@link issueSession} uses and for the same reason — the active key
 * lands before the cookie is sealed, so a failure can never hand the client a
 * credential the revocation check would immediately reject.
 */
export function issueBillingPortalCredential(
  args: IssueBillingPortalCredentialArgs
): ResultAsync<{ readonly sessionId: string }, DomainError> {
  const credential: BillingPortalClaims = {
    credentialKind: 'billing-portal',
    userId: args.userId,
    sessionId: args.sessionId,
    createdAt: args.now,
  };
  return redisSet(
    args.redis,
    IDENTITY_KEYS.billingPortalActive,
    '1',
    args.userId,
    args.sessionId
  ).andThen(() =>
    fromPromise(
      (async (): Promise<{ sessionId: string }> => {
        const session = await getIronSession<BillingPortalClaims>(
          args.request,
          args.response,
          billingPortalCookieOptions(args.secret, args.isProduction)
        );
        Object.assign(session, credential);
        await session.save();
        return { sessionId: args.sessionId };
      })(),
      (cause) => unavailableError('billing-portal cookie sealing failed', cause)
    )
  );
}

/**
 * Fans a realtime eviction out for a revoked user, best-effort: an absent
 * capability (a caller that has not wired it) and any fan-out failure both
 * resolve ok, so eviction never fails or gates the revocation. The closed
 * sockets plus the WS-upgrade re-auth are what make the revocation effective;
 * this is the push half, backstopped by the fail-closed broadcast-time
 * membership check when the fan-out cannot run.
 *
 * `sessionId` scopes the close to the one device that session authorizes.
 * Callers revoking every session the user holds — credential rotation, the
 * account lock, account deletion — omit it and close every device.
 */
export function evictUserBestEffort(
  evictUser: EvictUserPort | undefined,
  userId: string,
  sessionId?: string
): ResultAsync<void, DomainError> {
  if (evictUser === undefined) return okAsync();
  return fromPromise(evictUser.evictUser(userId, sessionId), (cause) =>
    unavailableError('realtime eviction fan-out failed', cause)
  ).orElse(() => okAsync());
}

/**
 * Deletes the sessionActive key — the revocation check answers `revoked`
 * from the next request on. Redis DEL converges atomically whether or not
 * the key still exists, which is what makes logout naturally idempotent.
 *
 * After the revocation state is written, a realtime eviction fans out to the
 * user's live rooms (best-effort — never fails or blocks the revoke), scoped to
 * the session being revoked: this revokes ONE session, so it closes only that
 * session's sockets and the user's other devices stay connected. Revoking every
 * session is the separate {@link revokeAllSessions} watermark, whose callers
 * compose an unscoped `evictUserBestEffort` on top (ARCHITECTURE §Streaming & realtime).
 */
export function revokeSession(
  redis: RedisClient,
  session: { readonly userId: string; readonly sessionId: string },
  evictUser?: EvictUserPort
): ResultAsync<void, DomainError> {
  return redisDel(redis, IDENTITY_KEYS.sessionActive, session.userId, session.sessionId).andThen(
    () => evictUserBestEffort(evictUser, session.userId, session.sessionId)
  );
}

/**
 * Revokes EVERY session a user holds by bumping the pw-changed watermark to
 * `now` — the same all-sessions revocation mechanism the account-deletion
 * executor and a credential rotation use. Unlike single-session `revokeSession`
 * there is no per-session `sessionActive` key to delete: the watermark is a
 * per-user boundary the revocation check compares every cookie's `createdAt`
 * against, so one write stales all sessions issued before now at once. Eviction
 * of live sockets is a separate best-effort concern the caller composes on top
 * (via `evictUserBestEffort`), because this primitive is the correctness layer —
 * the fail-closed broadcast-time session-liveness check reads this watermark.
 */
export function revokeAllSessions(
  redis: RedisClient,
  userId: string,
  now: number
): ResultAsync<void, DomainError> {
  return redisSet(redis, IDENTITY_KEYS.passwordChangedAt, now, userId);
}

/** Sets the expired removal cookie on the response. */
export async function destroySessionCookie(args: DestroyCookieArgs): Promise<void> {
  const session = await getIronSession(
    args.request,
    args.response,
    sessionCookieOptions(args.secret, args.isProduction)
  );
  session.destroy();
}
