import { pgTable, text, timestamp, index, pgEnum, numeric } from 'drizzle-orm/pg-core';

import { users } from './users';

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending', // Created, awaiting card submission
  'awaiting_webhook', // Helcim approved synchronously, waiting for webhook
  'confirmed', // Webhook received, balance credited
  'failed', // Payment failed or declined
]);

export const payments = pgTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Amount in USD with 8 decimal precision (e.g., "10.00000000")
    amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),

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
  ]
);
