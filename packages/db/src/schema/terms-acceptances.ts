import { pgTable, check, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

/**
 * Which Terms revision an account accepted, one row per revision, so a later
 * revision adds a row beside the earlier acceptance rather than replacing it.
 *
 * The row goes with the account: deletion is hard, so the evidence of
 * acceptance leaves with the account it describes. It records no IP address,
 * by data minimisation: storing one would need its own Privacy Policy change.
 * It records no platform, since the accepted text is the same on every surface.
 */
export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('terms_acceptances_user_revision_unique').on(table.userId, table.revision),
    check('terms_acceptances_revision_positive', sql`${table.revision} > 0`),
  ]
);
