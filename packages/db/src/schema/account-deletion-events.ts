import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const accountDeletionEvents = pgTable(
  'account_deletion_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('account_deletion_events_deleted_at_idx').on(table.deletedAt)]
);
