import { pgTable, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { verificationPurposeEnum } from './enums';
import { users } from './users';

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    purpose: verificationPurposeEnum('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('verification_tokens_user_id_idx').on(table.userId),
    // Backs the retention purge: expiry is what puts a row beyond the consume
    // DELETE, which matches unexpired rows only.
    index('verification_tokens_expires_at_idx').on(table.expiresAt),
  ]
);
