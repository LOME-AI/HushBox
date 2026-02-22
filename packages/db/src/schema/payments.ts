import { pgTable, text, timestamp, index, numeric, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

export const payments = pgTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    // Amount in USD with 8 decimal precision (e.g., "10.00000000")
    amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
    status: text('status').notNull().default('pending'),

    // Client-provided idempotency key for safe retries
    idempotencyKey: text('idempotency_key'),

    // Helcim identifiers
    helcimTransactionId: text('helcim_transaction_id').unique(),
    cardType: text('card_type'),
    cardLastFour: text('card_last_four'),

    // Error tracking
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    webhookReceivedAt: timestamp('webhook_received_at', { withTimezone: true }),
  },
  (table) => [
    index('payments_user_id_idx').on(table.userId),
    index('payments_helcim_transaction_id_idx').on(table.helcimTransactionId),
    unique('payments_user_idempotency_key').on(table.userId, table.idempotencyKey),
  ]
);
