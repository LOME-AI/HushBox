import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { messages } from './messages';

export const sharedMessages = pgTable('shared_messages', {
  id: text('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  // eslint-disable-next-line no-secrets/no-secrets -- false positive on column name
  shareBlob: bytea('share_blob').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
