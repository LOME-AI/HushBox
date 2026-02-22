import { pgTable, text, timestamp, index, integer, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { projects } from './projects';
import { users } from './users';

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: bytea('title').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    titleEpochNumber: integer('title_epoch_number').notNull().default(1),
    currentEpoch: integer('current_epoch').notNull().default(1),
    nextSequence: integer('next_sequence').notNull().default(1),
    conversationBudget: numeric('conversation_budget', { precision: 20, scale: 2 })
      .notNull()
      .default('0.00'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('conversations_user_id_idx').on(table.userId)]
);
