import { redisMGet, redisMGetEntry } from '../../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import type { RedisKeyDefinition } from '../../../../lib/redis/index.js';
import type {
  BillingPortalRevocationCheck,
  SessionRevocationCheck,
} from '../../../../lib/context/index.js';
import type { z } from 'zod';

/**
 * The three fields the session-liveness read needs, a subset of `SessionClaims`
 * — so the broadcast-time backstop can validate a socket's session snapshot
 * without carrying the full cookie shape.
 */
interface SessionLivenessInputs {
  readonly userId: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

/**
 * Liveness for one credential, over its own active key plus the ONE
 * password-changed watermark every credential kind shares. Two conditions
 * revoke: the active key is gone (logout, expiry, or admin revocation), or the
 * credential was issued before the password last changed (the watermark the
 * password-change/recovery flows write, and the one the account lock, account
 * deletion and chargeback revocations drive).
 *
 * Both keys are fetched in ONE round-trip: on `'*'` across many workers a second
 * sequential GET doubles the load on the single Redis HTTP proxy. The decision
 * is unchanged — an absent active key still revokes regardless of the
 * pw-changed value, any read failure still fails closed with an unavailable
 * error (the caller treats every error as a revoked credential).
 */
function checkCredentialLiveness<TSchema extends z.ZodType>(
  redis: Parameters<SessionRevocationCheck>[0],
  activeKey: RedisKeyDefinition<TSchema, readonly [string, string]>,
  inputs: SessionLivenessInputs
): ReturnType<SessionRevocationCheck> {
  return redisMGet(redis, [
    redisMGetEntry(activeKey, inputs.userId, inputs.sessionId),
    redisMGetEntry(IDENTITY_KEYS.passwordChangedAt, inputs.userId),
  ]).map(([active, changedAt]) => {
    if (active === null) return 'revoked' as const;
    return changedAt !== null && inputs.createdAt < changedAt
      ? ('revoked' as const)
      : ('active' as const);
  });
}

/**
 * The single source of session-revocation truth (published so the realtime
 * broadcast-time session-liveness backstop reuses it rather than reimplementing
 * the semantics).
 */
export function checkSessionLiveness(
  redis: Parameters<SessionRevocationCheck>[0],
  inputs: SessionLivenessInputs
): ReturnType<SessionRevocationCheck> {
  return checkCredentialLiveness(redis, IDENTITY_KEYS.sessionActive, inputs);
}

/**
 * The pipeline's injected session-liveness check (composed at the entry
 * layer; the middleware never imports this slice). Delegates to
 * `checkSessionLiveness` so the pipeline and the broadcast backstop share one
 * implementation.
 */
export const checkSessionRevocation: SessionRevocationCheck = (redis, claims) =>
  checkSessionLiveness(redis, claims);

/**
 * The billing-portal credential's liveness, on the handoff's own active key.
 * It runs the same semantics as the session check because the two must not
 * drift — a watermark rule that held for one credential and not the other
 * would leave a revoked handoff charging — and it reads the login session's
 * key never, so revoking one credential cannot revoke the other.
 */
export const checkBillingPortalRevocation: BillingPortalRevocationCheck = (redis, credential) =>
  checkCredentialLiveness(redis, IDENTITY_KEYS.billingPortalActive, credential);
