import { describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { SESSION_REVOKE_JOB_TYPE, enqueueWithinTx } from '../../../../lib/jobs/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import type { AdminUserDeps, AdminUserPostDeps } from './user.js';

const revokeAllContract = ADMIN_OP_CONTRACTS['sessions.revokeAll'];

/**
 * The compile half of the admin job-registry partition. An op body's registry
 * is typed `JobEnqueueRegistry`, whose `get` returns `EnqueueableJob` —
 * `RegisteredJob` minus `run`, the one callable that executes a job's work —
 * so a body reading `.run` off a registration does not typecheck. That is what
 * the `@ts-expect-error` in this file pins, and all it pins: a read the type
 * refuses, not a cast that goes around it.
 *
 * The cast is answered at runtime instead. The composition root binds
 * `enqueueOnlyRegistry`, which rebuilds each registration field by field with
 * no runner among them, so a cast past the type reads `undefined`; the
 * colocated composition test asserts that against the dependency object the
 * root really hands the engine. The two halves are load-bearing together —
 * bind the executable registry there and this file still passes while a body
 * reaches a runner.
 *
 * Preview runs the real body inside a transaction that is then rolled back,
 * and `session.revoke.v1`'s handler resolves its own Redis client and bumps
 * the password-changed watermark from `payload.userId` — a write no rollback
 * recalls.
 */
describe('user op job-registry surface', () => {
  it("keeps a job's runner out of an op body while leaving enqueue available", () => {
    const op = defineAdminOp<AdminUserDeps, (typeof revokeAllContract)['input'], AdminUserPostDeps>(
      revokeAllContract,
      {
        // Never invoked: this body exists to be typechecked. The
        // `@ts-expect-error` on the `run` read is the load-bearing
        // assertion — widen the registry surface a body holds back to the
        // executable one and the directive goes unused, which `tsc` rejects.
        execute: (ctx, input) => {
          // @ts-expect-error — a job's runner is an executable capability that resolves live infrastructure of its own; the registry an op body holds is typed `JobEnqueueRegistry`, which declares only the metadata the enqueue path reads, and the composition root binds a value with no runner on it
          const run: unknown = ctx.deps.jobRegistry.get(SESSION_REVOKE_JOB_TYPE)?.run;
          // The permitted form: the same registry, read for enqueue metadata,
          // writing a `jobs` row that the preview's rollback discards.
          const enqueued = enqueueWithinTx(ctx.tx, ctx.deps.jobRegistry, {
            type: SESSION_REVOKE_JOB_TYPE,
            payload: { userId: input.userId },
            dedupeKey: `session-revoke:${input.userId}`,
          });

          return okAsync({ effects: [{ label: 'partition', after: { run, enqueued } }] });
        },
      }
    );

    expect(op.contract.name).toBe('sessions.revokeAll');
  });
});

/**
 * The compile half of the admin identity-store partition. `identityStores.users`
 * publishes writes bound to the base `Database` handle — `enableTotp`,
 * `disableTotp`, `rotatePassword` — alongside the ones that take a caller's
 * transaction. The bound-to-the-handle ones do not run inside the engine's
 * settlement transaction, so a preview's rollback cannot undo them: a
 * `rotatePassword` from inside a preview rewrites the OPAQUE record and the
 * password-wrapped key, and the preview then reports that nothing happened.
 * An op body's surface therefore declares only the within-transaction writes
 * the ops compose, which is what the `@ts-expect-error`s below pin.
 *
 * As with the job registry, that is the compile half only. The composition root
 * builds the narrow surface field by field from the identity stores, so a body
 * that casts past the type reads `undefined` rather than a live mutator; the
 * colocated composition test asserts that against the dependency object the
 * root really hands the engine.
 */
describe('user op identity-store surface', () => {
  it('keeps base-database mutators out of an op body while leaving the containment writes available', () => {
    const op = defineAdminOp<AdminUserDeps, (typeof revokeAllContract)['input'], AdminUserPostDeps>(
      revokeAllContract,
      {
        // Never invoked: this body exists to be typechecked.
        execute: (ctx, input) => {
          // @ts-expect-error — `rotatePassword` rewrites the OPAQUE record through the base `Database` handle, not through the engine's settlement transaction, so a preview's rollback could not undo it; an op body's identity surface declares only the within-transaction containment writes
          const rotate: unknown = ctx.deps.identityStores.users.rotatePassword;
          // @ts-expect-error — `enableTotp` is the same handle-bound write, on the account's second factor
          const enable: unknown = ctx.deps.identityStores.users.enableTotp;
          // @ts-expect-error — `disableTotp` is the same handle-bound write, on the account's second factor
          const disable: unknown = ctx.deps.identityStores.users.disableTotp;
          // The permitted forms: the three containment writes the shipped ops
          // compose, each taking the engine's transaction, so preview rolls
          // them back.
          const locked = ctx.deps.identityStores.users.lockForDeletionWithinTx(
            ctx.tx,
            input.userId
          );
          const lock = ctx.deps.identityStores.users.lockUserWithinTx;
          const unlock = ctx.deps.identityStores.users.unlockUserWithinTx;

          return okAsync({
            effects: [
              { label: 'partition', after: { rotate, enable, disable, locked, lock, unlock } },
            ],
          });
        },
      }
    );

    expect(op.contract.name).toBe('sessions.revokeAll');
  });
});
