import { ADMIN_OP_CONTRACTS, MAX_STRANDED_TOTP_GROUPS } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import type { IdentityUsersStore } from '../../../identity/index.js';
import type { AdminOpEffect } from '../registry.js';

/**
 * The stranded-second-factor operations: the bulk pair
 * `twoFactor.clearStranded` ↔ `twoFactor.restoreStranded` and the per-user
 * pair `twoFactor.clear` ↔ `twoFactor.restore`, composed from identity's
 * published within-transaction doors.
 *
 * A stored TOTP secret sealed under a key this build no longer holds cannot be
 * verified, and every second-factor gate — login promotion, disable, account
 * deletion — refuses on it, so the account has no exit until an operator
 * clears the flag. Clearing RETAINS the ciphertext: that is what makes the act
 * reversible, and what makes the cleared state (flag off, ciphertext present)
 * distinguishable from a user's own disable, which nulls the ciphertext. The
 * bulk inverse's referee rests on that distinction, which is how it restores
 * exactly what a clear touched while recording key ids and counts rather than
 * user ids. The caveat the operator reads in the contract: after a true key
 * loss the inverse restores a state that is still stranded — it reverses the
 * operator's act, it does not recover the secret.
 */

const clearStrandedContract = ADMIN_OP_CONTRACTS['twoFactor.clearStranded'];
const restoreStrandedContract = ADMIN_OP_CONTRACTS['twoFactor.restoreStranded'];
const clearContract = ADMIN_OP_CONTRACTS['twoFactor.clear'];
const restoreContract = ADMIN_OP_CONTRACTS['twoFactor.restore'];

/**
 * The identity surface these bodies hold: the four transaction-scoped TOTP
 * doors and nothing else. Derived from {@link IdentityUsersStore} rather than
 * re-declared, and carried on its own dependency key — identity's other TOTP
 * transitions (`enableTotp`, `disableTotp`) are bound to the base database, so
 * a body calling one from inside a preview would perform a write the rollback
 * cannot undo, and `disableTotp` also nulls the ciphertext this pair retains.
 */
export interface AdminTwoFactorIdentityStores {
  readonly users: Pick<
    IdentityUsersStore,
    | 'clearTotpWithinTx'
    | 'disableStrandedTotpWithinTx'
    | 'restoreStrandedTotpWithinTx'
    | 'restoreTotpWithinTx'
  >;
}

export interface AdminTwoFactorDeps {
  readonly twoFactorStores: AdminTwoFactorIdentityStores;
  /**
   * The live TOTP key's id — which rows count as stranded is measured against
   * it. Supplied by the composition root, because an op body reads no
   * environment.
   */
  currentTotpKeyFingerprint(): Uint8Array;
}

/** One group as the audit row, the preview diff and the inverse input carry it. */
interface RecordedGroup {
  readonly fingerprint: string;
  readonly count: number;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Inverse of {@link toHex}. The contract admits only pairs of lowercase hex
 * digits, so every pair parses; a key id of some other width names no rows,
 * and the door's count check refuses it.
 */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Stable order, so a preview's effect list and its execute's are identical. */
function recordGroups(
  groups: readonly { readonly fingerprint: Uint8Array; readonly count: number }[]
): readonly RecordedGroup[] {
  return groups
    .map((group) => ({ fingerprint: toHex(group.fingerprint), count: group.count }))
    .toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function groupEffects(
  groups: readonly RecordedGroup[],
  before: string,
  after: string
): readonly AdminOpEffect[] {
  return groups.map((group) => ({
    label: `twoFactor.stranded:${group.fingerprint}`,
    before: `${before}:${String(group.count)}`,
    after: `${after}:${String(group.count)}`,
  }));
}

export const twoFactorClearStranded = defineAdminOp<
  AdminTwoFactorDeps,
  (typeof clearStrandedContract)['input']
>(clearStrandedContract, {
  execute: async (ctx, input) => {
    const groups = await ctx.deps.twoFactorStores.users.disableStrandedTotpWithinTx(
      ctx.tx,
      ctx.deps.currentTotpKeyFingerprint(),
      // Absent scope means the sweep; a named one narrows the act to those
      // retired keys. The narrowed form is what a restore's undo runs.
      input.keys?.map((key) => fromHex(key.fingerprint))
    );
    if (groups.length === 0) {
      return err(conflictError('no second factor stands on a retired key'));
    }
    if (groups.length > MAX_STRANDED_TOTP_GROUPS) {
      // The recorded groups ARE the inverse's input, so a clear spanning more
      // retired keys than one restore may name would commit an admin mutation
      // whose registered inverse cannot be run — refused here rather than
      // landed and left un-undoable (Reversibility Iron Law). The count says
      // how many retired keys still carry residue, which is how many batches
      // the per-user path implies and how far behind the re-seal job has
      // fallen; it reaches no operator today, because `respondDomainError`
      // answers `{ code }` and drops the message (the details channel a
      // `DomainError` would need is not on the type).
      return err(
        conflictError(
          `${String(groups.length)} retired keys carry a stranded second factor, more than the ${String(MAX_STRANDED_TOTP_GROUPS)} one restore may name; twoFactor.clear per user and the TOTP re-seal are the paths out`
        )
      );
    }
    const recorded = recordGroups(groups);
    return ok({
      effects: groupEffects(recorded, 'enabled', 'cleared'),
      inverseInput: { groups: recorded },
    });
  },
});

export const twoFactorRestoreStranded = defineAdminOp<
  AdminTwoFactorDeps,
  (typeof restoreStrandedContract)['input']
>(restoreStrandedContract, {
  execute: async (ctx, input) => {
    for (const group of input.groups) {
      const outcome = await ctx.deps.twoFactorStores.users.restoreStrandedTotpWithinTx(
        ctx.tx,
        fromHex(group.fingerprint),
        group.count
      );
      if (outcome === 'count-mismatch') {
        // All or nothing: the refusal rolls back every group already restored
        // in this transaction, so a half-applied restore — which no recorded
        // group would afterwards describe — can never commit.
        return err(conflictError('the recorded group no longer stands cleared under that key'));
      }
    }
    return ok({
      effects: groupEffects(input.groups, 'cleared', 'enabled'),
      // The undo of a restore is the clear, scoped to exactly the keys this
      // restore re-enabled. Recording no scope would hand the undo the sweep,
      // which re-measures every row against the live key and would clear
      // second factors standing under retired keys this restore never touched.
      // Scoped at key granularity, not row: which rows stand enabled under a
      // key can drift between the restore and its undo, and only another
      // operator act against that same key can move a row in or out — a
      // cardinality change the undo's own count fence then refuses.
      inverseInput: { keys: input.groups.map((group) => ({ fingerprint: group.fingerprint })) },
    });
  },
});

export const twoFactorClear = defineAdminOp<AdminTwoFactorDeps, (typeof clearContract)['input']>(
  clearContract,
  {
    execute: async (ctx, input) => {
      const outcome = await ctx.deps.twoFactorStores.users.clearTotpWithinTx(ctx.tx, input.userId);
      if (outcome.kind === 'not-found') return err(notFoundError('user does not exist'));
      if (outcome.kind === 'not-enabled') {
        return err(conflictError('account has no enabled second factor'));
      }
      return ok({
        effects: [{ label: 'user.twoFactor', before: 'enabled', after: 'cleared' }],
        target: { type: 'user', id: input.userId },
        inverseInput: { userId: input.userId },
      });
    },
  }
);

export const twoFactorRestore = defineAdminOp<
  AdminTwoFactorDeps,
  (typeof restoreContract)['input']
>(restoreContract, {
  execute: async (ctx, input) => {
    const outcome = await ctx.deps.twoFactorStores.users.restoreTotpWithinTx(ctx.tx, input.userId);
    if (outcome === 'not-found') return err(notFoundError('user does not exist'));
    if (outcome === 'not-cleared') {
      return err(conflictError('account has no cleared second factor to restore'));
    }
    return ok({
      effects: [{ label: 'user.twoFactor', before: 'cleared', after: 'enabled' }],
      target: { type: 'user', id: input.userId },
      inverseInput: { userId: input.userId },
    });
  },
});
