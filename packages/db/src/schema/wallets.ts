import { pgTable, text, timestamp, index, integer, numeric, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

export const wallets = pgTable(
  'wallets',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    balance: numeric('balance', { precision: 20, scale: 8 }).notNull().default('0'),
    priority: integer('priority').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('wallets_user_id_idx').on(table.userId),
    unique('wallets_user_type_unique').on(table.userId, table.type),
  ]
);
