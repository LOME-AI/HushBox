import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { enqueueWithinTx } from '../../../../lib/jobs/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { SESSION_REVOKE_JOB_TYPE, evictUserBestEffort } from '../../../identity/index.js';
import { defineAdminOp } from '../registry.js';
import type { JobEnqueueRegistry } from '../../../../lib/jobs/index.js';
import type { EvictUserPort, IdentityUsersStore } from '../../../identity/index.js';
import type { AdminOpContext } from '../registry.js';

/**
 * The user containment ops — the durable pair `user.lock` ↔ `user.unlock`
 * plus the system-owned `sessions.revokeAll` — composed from identity's
 * published surface. Lock is FULL containment: the durable `lockedAt` flag AND
 * a durable `session.revoke.v1` job commit together in the settlement
 * transaction; the job bumps the pw-changed watermark (revoking every live
 * session) with must-happen dispatcher retry, so the revocation cutoff can
 * never be lost the way a swallowed post-commit best-effort Redis bump could.
 * A post-commit ephemeral best-effort-evicts live sockets for promptness only.
 * Unlock deliberately does NOT restore sessions — a revoked session is
 * recreated by the user logging in again, so the Iron Law holds on the
 * effective-state projection. It is also why revocation has no inverse of its
 * own: such an op would restore revoked sessions.
 */

const lockContract = ADMIN_OP_CONTRACTS['user.lock'];
const unlockContract = ADMIN_OP_CONTRACTS['user.unlock'];
const revokeAllContract = ADMIN_OP_CONTRACTS['sessions.revokeAll'];

/** Injected clock — op-body modules may not call `Date.now()` (purity lint). */
export interface AdminOpsClock {
  now(): Date;
}

/**
 * The identity surface a user op body holds: the three within-transaction
 * containment writes these ops compose, and nothing else. Identity's own
 * `users` store also publishes writes bound to the base database rather than
 * to a caller's transaction — password rotation and the TOTP transitions among
 * them — and a body calling one from inside a preview would perform a write
 * the rollback cannot undo. Derived from {@link IdentityUsersStore} rather than
 * re-declared, so identity keeps the single statement of these signatures; the
 * composition root builds the value field by field, so a cast past this type
 * reads `undefined` rather than a live write.
 */
export interface AdminUserIdentityStores {
  readonly users: Pick<
    IdentityUsersStore,
    'lockForDeletionWithinTx' | 'lockUserWithinTx' | 'unlockUserWithinTx'
  >;
}

export interface AdminUserDeps {
  readonly identityStores: AdminUserIdentityStores;
  /**
   * Carries the `session.revoke.v1` registration for the in-transaction
   * enqueue. Enqueue-only by type: a handler reachable from a body would run
   * its real effect inside a preview, whose rollback discards the `jobs` row
   * but cannot recall the effect.
   */
  readonly jobRegistry: JobEnqueueRegistry;
}

/** What the engine hands the socket-eviction effect once the transaction has committed. */
export interface AdminUserPostDeps {
  readonly evictUser: EvictUserPort;
}

/**
 * The durable revocation cutoff user.lock and sessions.revokeAll share: a
 * `session.revoke.v1` job enqueued on the engine-owned settlement transaction,
 * so the all-session watermark bump commits atomically with the audit row and
 * is retried to completion by the dispatcher — never lost the way a swallowed
 * post-commit best-effort Redis write could be. The dedupe key is per-user, so
 * two overlapping containments collapse to one still-pending job (harmless —
 * the handler is naturally idempotent). In preview the transaction rolls back,
 * so no job is enqueued.
 */
async function enqueueSessionRevokeWithinTx(
  ctx: AdminOpContext<AdminUserDeps>,
  userId: string
): Promise<void> {
  await enqueueWithinTx(ctx.tx, ctx.deps.jobRegistry, {
    type: SESSION_REVOKE_JOB_TYPE,
    payload: { userId },
    dedupeKey: `session-revoke:${userId}`,
  });
}

/**
 * The post-commit best-effort socket eviction user.lock and sessions.revokeAll
 * share: promptness only. The durable revocation cutoff is the enqueued
 * `session.revoke.v1` job — once its watermark bump has committed, the
 * fail-closed broadcast-time session-liveness check kills any surviving socket
 * at its next broadcast. This eviction just makes that prompt; its failure is a
 * swallowed no-op and never fails the committed op.
 */
function registerSocketEviction(
  ctx: AdminOpContext<AdminUserDeps, AdminUserPostDeps>,
  name: string,
  userId: string
): void {
  ctx.registerEphemeral({
    name,
    run: async (post): Promise<void> => {
      await evictUserBestEffort(post.evictUser, userId).unwrapOr(null);
    },
  });
}

export const userLock = defineAdminOp<
  AdminUserDeps,
  (typeof lockContract)['input'],
  AdminUserPostDeps
>(lockContract, {
  execute: async (ctx, input) => {
    const outcome = await ctx.deps.identityStores.users.lockUserWithinTx(
      ctx.tx,
      input.userId,
      input.lockReason
    );
    if (outcome.kind === 'not-found') return err(notFoundError('user does not exist'));
    if (outcome.kind === 'already-locked') {
      // The standing lock (and its reason) is never clobbered: a second
      // lock's undo would unlock an account some earlier actor locked.
      return err(conflictError('user is already locked'));
    }
    await enqueueSessionRevokeWithinTx(ctx, input.userId);
    registerSocketEviction(ctx, 'user.lock.eviction', input.userId);
    return ok({
      effects: [
        { label: 'user.lock', before: 'unlocked', after: `locked:${input.lockReason}` },
        { label: 'user.sessions', before: 'active', after: 'revoked' },
      ],
      target: { type: 'user', id: input.userId },
      inverseInput: { userId: input.userId },
    });
  },
});

export const userUnlock = defineAdminOp<
  AdminUserDeps,
  (typeof unlockContract)['input'],
  AdminUserPostDeps
>(unlockContract, {
  execute: async (ctx, input) => {
    const outcome = await ctx.deps.identityStores.users.unlockUserWithinTx(ctx.tx, input.userId);
    if (outcome.kind === 'not-found') return err(notFoundError('user does not exist'));
    if (outcome.kind === 'not-locked') return err(conflictError('user is not locked'));
    return ok({
      effects: [
        { label: 'user.lock', before: `locked:${outcome.priorLockReason}`, after: 'unlocked' },
      ],
      target: { type: 'user', id: input.userId },
      // Inverse snapshot semantics: undo restores the ORIGINAL lock reason
      // (e.g. 'chargeback'), never a default 'admin'.
      inverseInput: {
        userId: input.userId,
        lockReason: outcome.priorLockReason,
      },
    });
  },
});

export const sessionsRevokeAll = defineAdminOp<
  AdminUserDeps,
  (typeof revokeAllContract)['input'],
  AdminUserPostDeps
>(revokeAllContract, {
  execute: async (ctx, input) => {
    // Existence check WITHIN the engine's transaction: the request's database
    // is serial, so a base-db read inside the open settlement transaction is
    // refused at once. Identity publishes no plain within-tx user read; the
    // deletion lock doubles as one (row lock + null-on-missing) and also
    // serializes against a concurrent deletion.
    const user = await ctx.deps.identityStores.users.lockForDeletionWithinTx(ctx.tx, input.userId);
    if (user === null) return err(notFoundError('user does not exist'));
    // The durable footprint is the audit row plus the enqueued
    // `session.revoke.v1` job (the revocation cutoff); both roll back in
    // preview. Socket eviction runs post-commit, best-effort, never in preview.
    await enqueueSessionRevokeWithinTx(ctx, input.userId);
    registerSocketEviction(ctx, 'sessions.revokeAll.eviction', input.userId);
    return ok({
      effects: [{ label: 'user.sessions', before: 'active', after: 'revoked' }],
      target: { type: 'user', id: input.userId },
    });
  },
});
