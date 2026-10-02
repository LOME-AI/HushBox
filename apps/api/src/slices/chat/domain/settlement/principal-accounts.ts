import { InfrastructureUnavailableError } from '../../../workflows/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import type { RunChargeDeps } from './run-charge-context.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';

const ACCOUNT_LOCK_FAILURE_MESSAGE =
  "chat settlement: the payer's and sender's accounts could not be locked";

/**
 * Locks the payer's account row and a member sender's FOR KEY SHARE: the first
 * lock every chat settlement commit takes, and taken again by the refusal
 * commit because a rolled-back savepoint releases it. Resolves to the ids of the
 * accounts that still exist.
 *
 * An account deletion takes its users row FOR UPDATE before touching anything
 * else, so locking the same rows first orders the two: a deletion already
 * holding a row commits before this lock is granted, and the row then reads as
 * gone; a deletion arriving later waits for this transaction to commit. Taken
 * after the conversation's FOR SHARE or the wallet's FOR UPDATE, the lock a
 * usage row's foreign-key check takes would wait on the deletion while the
 * deletion's cascade waits on those rows: a deadlock. A guest's link needs no
 * lock here; it goes only with its conversation, whose FOR SHARE already
 * serializes the settlement against that deletion.
 */
export async function lockPrincipalAccounts(
  tx: SettlementTx,
  deps: RunChargeDeps
): Promise<ReadonlySet<string>> {
  const { users } = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const { payerUserId, sender } = deps.identity;
  const userIds = new Set([payerUserId]);
  if (sender.kind === 'user') userIds.add(sender.userId);
  const present = new Set<string>();
  for (const userId of userIds) {
    const row = await users.lockForKeyShare(userId).match(
      (locked) => locked,
      (error) => {
        throw new InfrastructureUnavailableError(ACCOUNT_LOCK_FAILURE_MESSAGE, error.cause);
      }
    );
    if (row !== null) present.add(row.id);
  }
  return present;
}
