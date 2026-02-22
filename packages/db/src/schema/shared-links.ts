import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { isNull, sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';

export const sharedLinks = pgTable(
  'shared_links',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    linkPublicKey: bytea('link_public_key').notNull(),
    displayName: text('display_name'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('shared_links_public_key_unique').on(table.linkPublicKey),
    index('shared_links_conversation_active_idx')
      .on(table.conversationId)
      .where(isNull(table.revokedAt)),
  ]
);
