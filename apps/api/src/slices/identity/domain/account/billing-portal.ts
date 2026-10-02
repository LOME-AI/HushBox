import { z } from 'zod';
import { fromPromise, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { redisGet, redisSet } from '../../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { issueBillingPortalCredential } from '../session/session.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { IdentityUsersStore } from '../../ports/index.js';
import type { RedisClient } from '../keys.js';

export const billingTokenLoginBodySchema = z.object({
  token: z.uuid(),
});

interface IssueBillingLoginTokenArgs {
  readonly redis: RedisClient;
  readonly userId: string;
}

/**
 * Mints the short-lived billing-portal handoff token the mobile app exchanges
 * for the web billing-portal credential (legacy `/billing/login-link` contract:
 * `{ token }`, 60-second TTL, multi-use within it). Exposed on the slice
 * barrel for the billing slice's login-link route.
 */
export function issueBillingLoginToken(
  args: IssueBillingLoginTokenArgs
): ResultAsync<{ readonly token: string }, DomainError> {
  const token = crypto.randomUUID();
  return redisSet(args.redis, IDENTITY_KEYS.billingLoginToken, { userId: args.userId }, token).map(
    () => ({ token })
  );
}

/**
 * Deterministic credential id from the login token: SHA-256, first 16 bytes,
 * uuid-formatted. The token IS the idempotency key, so every redemption of
 * one token converges on the same id — the same active key, the same claims,
 * no orphaned credentials, no double-mint under races.
 */
function deriveBillingCredentialId(token: string): ResultAsync<string, DomainError> {
  return fromPromise(
    (async (): Promise<string> => {
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const h = [...new Uint8Array(hashBuffer.slice(0, 16))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    })(),
    (cause) => unavailableError('credential id derivation failed', cause)
  );
}

interface BillingTokenLoginArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly token: string;
  readonly request: Request;
  readonly response: Response;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly now: number;
}

/**
 * `invalid` is deliberately uniform: an unknown token, an expired token, a
 * vanished user, and a locked account are indistinguishable to the caller
 * (enumeration-safe — the endpoint is public).
 */
export type BillingTokenLoginOutcome =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'logged-in' };

const INVALID: BillingTokenLoginOutcome = { kind: 'invalid' };

/**
 * Redeems a billing-portal token for the billing-portal credential — never a
 * login session. The token is read, never consumed: its 60-second TTL is the
 * expiry and the deterministic credential id (above) makes every redemption
 * converge, which is what makes the flow safe for StrictMode double-fires,
 * reloads, and network retries. Diverges from legacy in one way: a locked
 * account is refused (legacy predates `lockedAt`-aware issuance).
 */
export function billingTokenLogin(
  args: BillingTokenLoginArgs
): ResultAsync<BillingTokenLoginOutcome, DomainError> {
  return redisGet(args.redis, IDENTITY_KEYS.billingLoginToken, args.token).andThen((stored) =>
    stored === null
      ? okAsync<BillingTokenLoginOutcome, DomainError>(INVALID)
      : loginResolvedUser(args, stored.userId)
  );
}

function loginResolvedUser(
  args: BillingTokenLoginArgs,
  userId: string
): ResultAsync<BillingTokenLoginOutcome, DomainError> {
  return args.store.findById(userId).andThen((user) => {
    // Vanished user (missing → undefined ≠ null) and locked account collapse
    // onto the same uniform refusal as an unknown token.
    if (user?.lockedAt !== null) {
      return okAsync<BillingTokenLoginOutcome, DomainError>(INVALID);
    }
    return issueBillingCredential(args, user.id);
  });
}

function issueBillingCredential(
  args: BillingTokenLoginArgs,
  userId: string
): ResultAsync<BillingTokenLoginOutcome, DomainError> {
  return deriveBillingCredentialId(args.token).andThen((sessionId) =>
    issueBillingPortalCredential({
      request: args.request,
      response: args.response,
      redis: args.redis,
      secret: args.secret,
      isProduction: args.isProduction,
      userId,
      now: args.now,
      sessionId,
    }).map((): BillingTokenLoginOutcome => ({ kind: 'logged-in' }))
  );
}
