import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * Chat's published surface for identity's account-deletion transaction
 * (single-writer: this slice owns `messages` and `content_items`). Each runs
 * on the branded `SettlementTx` and THROWS on failure, aborting the whole
 * deletion commit — a partial deletion can never persist.
 */

/**
 * The DISTINCT non-null storage keys of every content item in the given
 * conversations. The deletion transaction captures these from the user's
 * OWNED conversations BEFORE the `users` delete cascades the rows away — the
 * captured list becomes the reclaim job's payload, the only surviving map
 * from the account to its R2 ciphertext.
 */
export async function captureContentStorageKeysWithinTx(
  tx: SettlementTx,
  conversationIds: readonly string[]
): Promise<readonly string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ key: contentItems.storageKey })
    .from(contentItems)
    .innerJoin(messages, eq(contentItems.messageId, messages.id))
    .where(
      and(
        inArray(messages.conversationId, [...conversationIds]),
        isNotNull(contentItems.storageKey)
      )
    );
  /* v8 ignore next -- the query filters isNotNull(contentItems.storageKey), so row.key is never null at runtime; the null arm satisfies the column's nullable type only */
  return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
}

/**
 * Erases the content of the user's messages OUTSIDE the owned conversations:
 * deletes their `content_items` rows and stamps `messages.deletedAt`, keeping
 * the rows so threads, forks and sequence numbers stay whole. Returns the
 * DISTINCT non-null storage keys of the deleted items, captured before the
 * delete — the only surviving map to their R2 ciphertext. Must run before
 * {@link detachMessageSendersWithinTx}, which removes the sender id this
 * selects on. Assistant messages carry a fixed sender id, so they are never
 * selected.
 */
export async function deleteForeignMessageContentWithinTx(
  tx: SettlementTx,
  userId: string,
  ownedConversationIds: readonly string[],
  deletedAt: Date
): Promise<readonly string[]> {
  const foreignMessages = foreignMessagesOf(userId, ownedConversationIds);
  const selected = tx.select({ id: messages.id }).from(messages).where(foreignMessages);
  const rows = await tx
    .selectDistinct({ key: contentItems.storageKey })
    .from(contentItems)
    .where(and(inArray(contentItems.messageId, selected), isNotNull(contentItems.storageKey)));
  await tx.delete(contentItems).where(inArray(contentItems.messageId, selected));
  await tx.update(messages).set({ deletedAt }).where(foreignMessages);
  /* v8 ignore next -- the query filters isNotNull(contentItems.storageKey), so row.key is never null at runtime; the null arm satisfies the column's nullable type only */
  return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
}

/**
 * Nulls `messages.senderId` for the user's messages OUTSIDE the excluded
 * (owned) conversations. senderId deliberately has no FK — a sender may be a
 * link-guest with no users row — so the `users` delete would otherwise leave
 * dangling ids; owned conversations are excluded because their messages die
 * with the conversation cascade anyway. Backed by messages_sender_id_idx.
 */
export async function detachMessageSendersWithinTx(
  tx: SettlementTx,
  userId: string,
  excludedConversationIds: readonly string[]
): Promise<void> {
  await tx
    .update(messages)
    .set({ senderId: null })
    .where(foreignMessagesOf(userId, excludedConversationIds));
}

/** The user's messages outside the given conversations. */
function foreignMessagesOf(
  userId: string,
  excludedConversationIds: readonly string[]
): SQL | undefined {
  const ownMessages = eq(messages.senderId, userId);
  return excludedConversationIds.length === 0
    ? ownMessages
    : and(ownMessages, notInArray(messages.conversationId, [...excludedConversationIds]));
}
