import { pgTable, text, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { usageRecords } from './usage-records';

export const mediaGenerations = pgTable(
  'media_generations',
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
    mediaType: text('media_type').notNull(),
    imageCount: integer('image_count'),
    durationMs: integer('duration_ms'),
    resolution: text('resolution'),
  },
  (table) => [index('media_generations_model_idx').on(table.model)]
);
