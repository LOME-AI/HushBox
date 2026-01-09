import { pgTable, text, timestamp, index, numeric } from 'drizzle-orm/pg-core';

import { balanceTransactions } from './balance-transactions';
import { conversations } from './conversations';

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    model: text('model'),
    balanceTransactionId: text('balance_transaction_id').references(() => balanceTransactions.id, {
      onDelete: 'set null',
    }),
    cost: numeric('cost', { precision: 20, scale: 8 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('messages_conversation_id_idx').on(table.conversationId)]
);
