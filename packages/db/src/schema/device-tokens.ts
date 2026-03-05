import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

// Device tokens accumulate as users install/uninstall the app.
// Stale tokens (uninstalled apps) cause FCM delivery failures but are
// otherwise harmless. Periodic cleanup of tokens with old updatedAt
// will be needed as the user base grows.
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('device_tokens_user_id_idx').on(table.userId)]
);
