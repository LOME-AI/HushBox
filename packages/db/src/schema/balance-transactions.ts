import { pgTable, text, timestamp, index, pgEnum, numeric } from 'drizzle-orm/pg-core';

import { payments } from './payments';
import { users } from './users';

export const balanceTransactionTypeEnum = pgEnum('balance_transaction_type', [
  'deposit', // Money added from confirmed payment
  'usage', // Money spent on AI usage (negative amount)
  'adjustment', // Manual admin adjustment
]);

export const balanceTransactions = pgTable(
  'balance_transactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Signed decimal: positive = credit, negative = debit
    amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 20, scale: 8 }).notNull(),
    type: balanceTransactionTypeEnum('type').notNull(),

    // Links to source
    paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    description: text('description').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('balance_transactions_user_id_idx').on(table.userId)]
);
