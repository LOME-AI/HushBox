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
