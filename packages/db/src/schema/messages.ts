import { pgTable, text, timestamp, index, integer, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    encryptedBlob: bytea('encrypted_blob').notNull(),
    senderType: text('sender_type').notNull(),
    senderId: text('sender_id'),
    senderDisplayName: text('sender_display_name'),
    payerId: text('payer_id'),
    cost: numeric('cost', { precision: 20, scale: 8 }),
    epochNumber: integer('epoch_number').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('messages_conversation_sequence_idx').on(table.conversationId, table.sequenceNumber),
    index('messages_conversation_epoch_idx').on(table.conversationId, table.epochNumber),
  ]
);
