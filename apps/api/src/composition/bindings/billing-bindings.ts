import { createWebhookVerifier } from '../../slices/billing/index.js';
import {
  createIdentityStores,
  createSessionRevokeJobRegistration,
} from '../../slices/identity/index.js';
import { enqueueOnlyDeps } from '../../lib/jobs/index.js';
import { requestDb } from '../../lib/context/index.js';
import { rateLimitBound } from '../../lib/rate-limit/index.js';
import { createBoundedRedis } from '../../lib/resilience/index.js';
import type { AccountDefensePort, WebhookVerifier } from '../../slices/billing/index.js';
import type { IdentityUsersStore } from '../../slices/identity/index.js';
import type { JobRegistration } from '../../lib/jobs/index.js';
import type { EnvContext } from '@hushbox/shared';

/**
 * Composition-root wiring for the billing manifest's env/infra-dependent deps.
 * These live outside a slice on purpose: they compose a published barrel with a
 * Worker binding, which slice code (and `lib`) may not reach across.
 */

/** The structural slice of the env the webhook verifier needs — HELCIM_WEBHOOK_VERIFIER is a secret, not on the typed Bindings. */
interface WebhookVerifierEnv extends EnvContext {
  readonly HELCIM_WEBHOOK_VERIFIER?: string;
}

/**
 * Binds billing's fail-closed Helcim webhook verifier to the request env. The
 * verifier constructor is itself fail-fast on a missing/corrupt secret, so a
 * misconfigured deploy rejects at first use rather than degrading.
 */
export function createWebhookVerifierFromEnv(env: WebhookVerifierEnv): WebhookVerifier {
  return createWebhookVerifier({ verifier: env.HELCIM_WEBHOOK_VERIFIER });
}

/** The per-invocation infra the chargeback lock composes; resolved fresh each call. */
interface AccountDefenseDeps {
  readonly users: IdentityUsersStore;
}

/**
 * The chargeback auto-defense LOCK port over identity's published within-tx
 * lock — identity is the single writer of `users`, so billing reaches the
 * `lockedAt` flip through this port rather than writing the row itself.
 * The lock runs inside the webhook's clawback
 * `SettlementTx`, so the ledger clawback and the `users.lockedAt` flip commit
 * atomically — a lock failure throws and rolls the clawback back, and the
 * provider's redelivery re-drives both (no money-reversed-but-not-locked
 * divergence). The `resolve` seam supplies per-request infra (the `createApp*`
 * shape), keeping the composition unit-testable with a fake store.
 *
 * Session revocation is deliberately NOT here: it is the must-happen
 * `session.revoke.v1` job, enqueued in the same transaction and executed by
 * the dispatcher (so a transient watermark/Redis failure is retried to
 * completion instead of being swallowed by a best-effort post-commit tail). The
 * lock is reversible (an admin unlock clears `lockedAt`) and defensive.
 */
export function createAccountDefense(resolve: () => AccountDefenseDeps): AccountDefensePort {
  return {
    lockForChargebackWithinTx(tx, userId) {
      return resolve().users.lockForChargebackWithinTx(tx, userId);
    },
  };
}

/**
 * The composition-root binding for billing's chargeback auto-defense lock.
 * Only actual chargeback/reversal events against a captured payment reach
 * it. Each call resolves the identity users store (single writer of `users`)
 * fresh from the ambient request scope through {@link requestDb}, and the lock
 * runs inside the webhook's clawback `SettlementTx` so the ledger reversal and
 * `users.lockedAt` flip commit atomically.
 */
export function createAppAccountDefensePort(): AccountDefensePort {
  return createAccountDefense(() => ({
    users: createIdentityStores(requestDb()).users,
  }));
}

/** The structural slice of the env the enqueue-side session-revoke registration needs. */
interface SessionRevokeEnqueueEnv extends EnvContext {
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
}

/**
 * The enqueue-side `session.revoke.v1` registration for the billing webhook's
 * job registry. `enqueueWithinTx` reads only the registered type/schema/lease/
 * shard, so the Redis handed in is never invoked here — the handler runs in the
 * dispatcher DO with its own registry (`createDispatcherJobRegistry`). Registering
 * it is what keeps the webhook's clawback settlement from throwing "unregistered
 * job type" (which would roll the clawback back and 503-loop Helcim's redelivery).
 * Fails fast on a missing Redis binding, which the request pipeline already
 * guarantees present on every webhook — this construction never actually throws in
 * production, and the client is HTTP-lazy so no socket opens.
 *
 * The client is built through the bounded factory even though it carries no
 * command today, so the one construction that is never exercised is not also
 * the one that is unbounded. Its deadline comes from the entry the bindings
 * stage already put in force for this isolate, not from a literal here — a
 * constant at this site would be the one value in the system that ignores the
 * mode it runs in.
 */
export function createSessionRevokeEnqueueRegistration(
  env: SessionRevokeEnqueueEnv
): JobRegistration {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || url === '' || token === undefined || token === '') {
    throw new Error(
      'billing session-revoke enqueue: missing UPSTASH_REDIS_REST_URL/TOKEN — ' +
        'fails fast instead of degrading.'
    );
  }
  return createSessionRevokeJobRegistration({
    resolveRevoke: enqueueOnlyDeps({
      redis: createBoundedRedis({ url, token }, rateLimitBound().timeoutMs),
    }),
  });
}
