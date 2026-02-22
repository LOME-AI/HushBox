import { pgTable, text, timestamp, integer, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';

export const epochs = pgTable(
  'epochs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    epochNumber: integer('epoch_number').notNull(),
    epochPublicKey: bytea('epoch_public_key').notNull(),
    confirmationHash: bytea('confirmation_hash').notNull(),
    chainLink: bytea('chain_link'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('epochs_conversation_epoch_unique').on(table.conversationId, table.epochNumber),
  ]
);
