import { toBase64 } from '@hushbox/shared';
import { duplicateFreshHandshakeDefect, okAsync, identitySecretsFromEnv } from '../domain/index.js';
import type { Context } from 'hono';
import type { AppEnv, SessionClaims } from '../../../middleware/pipeline-manifest.js';
import type {
  IdentitySecrets,
  DomainError,
  IdentityUserRecord,
  IdentityUsersStore,
  OpaqueFinishFlow,
  RedisClient,
  ResultAsync,
} from '../domain/index.js';
import type { IdentityRouteDeps } from './deps.js';

/** The full-login success payload: the wrapped key rides back for client-side unwrap. */
export function loginSuccessBody(user: IdentityUserRecord): {
  success: true;
  userId: string;
  email: string;
  passwordWrappedPrivateKey: string;
} {
  return {
    success: true as const,
    userId: user.id,
    email: user.email,
    passwordWrappedPrivateKey: toBase64(user.passwordWrappedPrivateKey),
  };
}

/**
 * The claims of a `session`-class route (a full principal is guaranteed by the
 * authorizer). A non-full principal here is a pipeline-composition defect.
 */
export function fullClaims(c: Context<AppEnv>): SessionClaims {
  const principal = c.var.principal;
  if (principal.kind !== 'full') {
    throw new Error('identity: session-class route reached without a full principal');
  }
  return principal.claims;
}

/**
 * The infra trio every OPAQUE-family domain call draws from the request
 * context. Each call types the subset of secrets it reads; the rest ride
 * along unread.
 */
export function opaqueDeps(
  c: Context<AppEnv>,
  deps: IdentityRouteDeps
): { redis: RedisClient; store: IdentityUsersStore; secrets: IdentitySecrets } {
  return {
    redis: c.var.redis,
    store: deps.stores(c.var.db).users,
    secrets: identitySecretsFromEnv(c.env),
  };
}

/** Growth's active-tag read, bound to this request's database handle. */
export function listActiveTags(
  c: Context<AppEnv>,
  deps: IdentityRouteDeps
): () => ResultAsync<readonly string[], DomainError> {
  return () => deps.growthStores.listActiveCampaignTags(c.var.db);
}

/**
 * `byEventId` params for an init round: the handshake id is minted server-side
 * inside `execute` (a fresh uuid per request), so the claim trivially wins and
 * a duplicate delivery is a defect. Finish rounds pass their flow (whose
 * atomic consume IS the claim) to `idempotent.byEventId` directly; the
 * wrapper call itself stays inline at every route seam (arch-rule contract).
 */
export function freshHandshake<T>(execute: () => ResultAsync<T, DomainError>): OpaqueFinishFlow<T> {
  return {
    claim: () => okAsync<boolean, DomainError>(true),
    execute,
    onDuplicate: duplicateFreshHandshakeDefect,
  };
}
