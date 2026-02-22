import { pgTable, text, index, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { usageRecords } from './usage-records';

export const llmCompletions = pgTable(
  'llm_completions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    usageRecordId: text('usage_record_id')
      .notNull()
      .unique()
      .references(() => usageRecords.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull().default(0),
  },
  (table) => [index('llm_completions_model_idx').on(table.model)]
);
