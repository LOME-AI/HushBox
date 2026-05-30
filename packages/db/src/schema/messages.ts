import { pgTable, text, timestamp, index, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(),
    senderId: text('sender_id'),
    wrappedContentKey: bytea('wrapped_content_key').notNull(),
    epochNumber: integer('epoch_number').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    parentMessageId: text('parent_message_id'),
    /**
     * Per-turn identifier shared by every message persisted in a single
     * `saveChatTurn`. Two assistant messages with the same parent are
     * multi-model peers iff their `batchId`s match. The fork-filter uses
     * this to distinguish parallel multi-model fan-out (always travel with
     * their shared parent) from fork-preserved orphans created when a retry
     * upstream of a fork-branch had to keep the prior assistant alive
     * because the fork's descendants still pointed at it. Defaults to `id`
     * so legacy rows pre-migration are each their own batch (sibling
     * comparison returns false — falls back to containment).
     */
    batchId: text('batch_id')
      .notNull()
      .default(sql`gen_random_uuid()::text`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('messages_conversation_sequence_idx').on(
      table.conversationId,
      table.sequenceNumber
    ),
    index('messages_conversation_epoch_idx').on(table.conversationId, table.epochNumber),
    index('messages_parent_message_id_idx').on(table.parentMessageId),
    // Backs the account-deletion saga's `UPDATE messages SET sender_id = NULL
    // WHERE sender_id = $userId` so the saga cannot seq-scan the table.
    index('messages_sender_id_idx').on(table.senderId).where(isNotNull(table.senderId)),
  ]
);
