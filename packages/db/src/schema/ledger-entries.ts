import { pgTable, text, timestamp, index, numeric } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { payments } from './payments';
import { usageRecords } from './usage-records';
import { wallets } from './wallets';

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    walletId: text('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 20, scale: 8 }).notNull(),
    entryType: text('entry_type').notNull(),
    paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    usageRecordId: text('usage_record_id').references(() => usageRecords.id, {
      onDelete: 'set null',
    }),
    sourceWalletId: text('source_wallet_id').references(() => wallets.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ledger_entries_wallet_created_idx').on(table.walletId, table.createdAt),
    index('ledger_entries_usage_record_idx')
      .on(table.usageRecordId)
      .where(isNotNull(table.usageRecordId)),
  ]
);
