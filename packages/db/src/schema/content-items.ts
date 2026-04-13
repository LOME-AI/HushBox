import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { messages } from './messages';

export const contentItems = pgTable(
  'content_items',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    position: integer('position').notNull().default(0),

    encryptedBlob: bytea('encrypted_blob'),

    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),

    modelName: text('model_name'),
    cost: numeric('cost', { precision: 20, scale: 8 }),
    isSmartModel: boolean('is_smart_model').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('content_items_message_id_position_idx').on(table.messageId, table.position),
    uniqueIndex('content_items_storage_key_idx')
      .on(table.storageKey)
      .where(sql`${table.storageKey} IS NOT NULL`),
    check(
      'content_items_type_consistency',
      sql`
        (${table.contentType} = 'text'
          AND ${table.encryptedBlob} IS NOT NULL
          AND ${table.storageKey} IS NULL
          AND ${table.mimeType} IS NULL
          AND ${table.sizeBytes} IS NULL)
        OR (${table.contentType} IN ('image', 'audio', 'video')
          AND ${table.storageKey} IS NOT NULL
          AND ${table.mimeType} IS NOT NULL
          AND ${table.sizeBytes} IS NOT NULL
          AND ${table.encryptedBlob} IS NULL)
      `
    ),
  ]
);
