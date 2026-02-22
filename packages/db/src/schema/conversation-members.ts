import { pgTable, text, timestamp, index, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { isNull, sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { sharedLinks } from './shared-links';
import { users } from './users';

export const conversationMembers = pgTable(
  'conversation_members',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    linkId: text('link_id').references(() => sharedLinks.id, { onDelete: 'set null' }),
    privilege: text('privilege').notNull().default('write'),
    visibleFromEpoch: integer('visible_from_epoch').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    invitedByUserId: text('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('conversation_members_user_active')
      .on(table.conversationId, table.userId)
      .where(isNull(table.leftAt)),
    uniqueIndex('conversation_members_link_active')
      .on(table.conversationId, table.linkId)
      .where(isNull(table.leftAt)),
    index('conversation_members_active_idx').on(table.conversationId).where(isNull(table.leftAt)),
    index('conversation_members_user_active_lookup_idx')
      .on(table.userId)
      .where(isNull(table.leftAt)),
  ]
);
