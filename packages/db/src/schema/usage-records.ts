import { pgTable, text, timestamp, index, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    cost: numeric('cost', { precision: 20, scale: 8 }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('usage_records_user_type_created_idx').on(table.userId, table.type, table.createdAt),
    index('usage_records_source_idx').on(table.sourceType, table.sourceId),
  ]
);
