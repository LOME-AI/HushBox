import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { messages } from './messages';

export const conversationForks = pgTable(
  'conversation_forks',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tipMessageId: text('tip_message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('conversation_forks_conv_name_idx').on(table.conversationId, table.name),
    index('conversation_forks_conv_idx').on(table.conversationId),
  ]
);
