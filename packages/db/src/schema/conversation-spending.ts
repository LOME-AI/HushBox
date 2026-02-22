import { pgTable, text, timestamp, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';

export const conversationSpending = pgTable('conversation_spending', {
  id: text('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  conversationId: text('conversation_id')
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  totalSpent: numeric('total_spent', { precision: 20, scale: 8 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
