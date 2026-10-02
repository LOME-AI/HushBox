import { and, eq, inArray, isNull } from 'drizzle-orm';
import { conversationMembers, conversations, sharedLinks } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * The conversations slice's published surface for identity's account-deletion
 * transaction (single-writer: this slice owns `conversations` and
 * `conversation_members`). Both run on the branded `SettlementTx` and THROW on
 * failure — inside the one deletion transaction a throw aborts the whole
 * commit, so a partial deletion can never persist.
 */

/**
 * The ids of every conversation the user OWNS. The deletion transaction
 * captures these before the `users` delete cascades them away: they scope the
 * chat slice's storage-key capture (owned content dies with the cascade) and
 * its sender scrub (foreign conversations survive, so those messages are
 * detached instead).
 */
export async function ownedConversationIdsWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<readonly string[]> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  return rows.map((row) => row.id);
}

/**
 * Deletes every conversation the user OWNS (messages/content cascade with
 * them). Runs INSIDE the deletion transaction, BEFORE the `users` delete —
 * relying on the users→conversations cascade instead aborts the commit. The
 * users delete triggers two overlapping actions on the same membership row of an
 * owned conversation: the conversationId→conversations CASCADE deletes it, while
 * the userId→users SET NULL updates it. Because this transaction already modified
 * that row (leftAt) earlier in the same command, Postgres raises "tuple to be
 * updated was already modified by an operation triggered by the current command".
 * Deleting the owned conversations first removes their membership rows before
 * any SET NULL can touch them.
 */
export async function deleteOwnedConversationsWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<void> {
  await tx.delete(conversations).where(eq(conversations.userId, userId));
}

/**
 * The bulk leave: stamps `leftAt` on every ACTIVE membership of the user.
 * Must run BEFORE the `users` delete — its FK sets `userId` null, and the
 * surviving row satisfies the `userId OR linkId OR leftAt` check only once
 * `leftAt` is set. Already-departed rows keep their original timestamp. Like
 * any departure it rotates nothing: each conversation stays rotation-pending
 * until a remaining member's client rotates the departed key out.
 */
export async function leaveAllMembershipsWithinTx(
  tx: SettlementTx,
  userId: string,
  leftAt: Date
): Promise<void> {
  await tx
    .update(conversationMembers)
    .set({ leftAt })
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)));
}

/**
 * Ends every shared link the departing user minted: `revokedAt` on the live
 * ones, `leftAt` on the guest seats they hold. Authorization-only revocation,
 * the same shape the admin revoke takes — the server holds no key material, so
 * the epoch is NOT rotated here and a guest still holding the link's private key
 * can still open ciphertext it already had. The conversation turns
 * rotation-pending instead: nothing new is encrypted to the epoch the guest
 * holds until a remaining member's client rotates it out, and every future
 * credential resolution ends now. Must run BEFORE the `users` delete, whose
 * FK nulls `shared_links.createdBy` and leaves the links unfindable by creator.
 * The link rows themselves survive the deletion, revoked and creatorless. The
 * row IS the record of the revocation: `share.unrevoke`, the registered inverse
 * that keeps the admin revoke from being an irreversible admin operation, can
 * only restore a link that still exists. To the conversation's owner a
 * creator-deletion revoke reads like any other — `listForConversation` excludes
 * revoked links, so it leaves their list.
 */
export async function revokeLinksCreatedByWithinTx(
  tx: SettlementTx,
  userId: string,
  revokedAt: Date
): Promise<void> {
  const revoked = await tx
    .update(sharedLinks)
    .set({ revokedAt })
    .where(and(eq(sharedLinks.createdBy, userId), isNull(sharedLinks.revokedAt)))
    .returning({ id: sharedLinks.id });
  if (revoked.length === 0) return;
  await tx
    .update(conversationMembers)
    .set({ leftAt: revokedAt })
    .where(
      and(
        inArray(
          conversationMembers.linkId,
          revoked.map((row) => row.id)
        ),
        isNull(conversationMembers.leftAt)
      )
    );
}
