import { pgTable, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';
import { users } from './users';

/**
 * revokedAt + expiresAt are enforced lazily at the read path — a
 * predicate, not a process.
 */
export const sharedLinks = pgTable(
  'shared_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // The minter, so account deletion can end the links they issued. The row
    // itself outlives its creator pseudonymized (SET NULL) rather than cascading
    // away: it is the record of the revocation, and the admin `share.unrevoke`
    // inverse — without which revoking would be an irreversible admin operation
    // — can only restore a link that still exists. It also keeps end-of-life
    // uniform, since a link minted before this column carries no creator and can
    // end only through revokedAt/expiresAt. Nullable for those same links.
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    linkPublicKey: bytea('link_public_key').notNull().unique(),
    linkAuthHash: bytea('link_auth_hash').notNull().unique(),
    displayName: text('display_name'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('shared_links_conversation_id_idx').on(table.conversationId),
    index('shared_links_created_by_idx').on(table.createdBy),
  ]
);
