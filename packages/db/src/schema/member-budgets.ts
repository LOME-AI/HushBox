import { pgTable, text, timestamp, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversationMembers } from './conversation-members';

export const memberBudgets = pgTable('member_budgets', {
  id: text('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  memberId: text('member_id')
    .notNull()
    .unique()
    .references(() => conversationMembers.id, { onDelete: 'cascade' }),
  budget: numeric('budget', { precision: 20, scale: 2 }).notNull().default('0.00'),
  spent: numeric('spent', { precision: 20, scale: 8 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
