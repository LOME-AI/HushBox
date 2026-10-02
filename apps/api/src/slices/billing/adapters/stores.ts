import { createBudgetStores } from './budget-stores.js';
import { createPaymentStores } from './payment-stores.js';
import { createUsageStores } from './usage-stores.js';
import { createWalletLedgerStores } from './wallet-ledger-stores.js';
import type { BillingStores } from '../ports/index.js';

/**
 * The billing slice's single-writer repository: every raw Drizzle mutation on
 * billing's tables lives here, behind the `BillingStores` port. Within-tx
 * methods throw on violated expectations — inside `runSettlement` a throw
 * aborts the whole transaction, which is the fail-fast the single-settlement
 * rule requires.
 */
export function createBillingStores(): BillingStores {
  return {
    ...createWalletLedgerStores(),
    ...createUsageStores(),
    ...createPaymentStores(),
    ...createBudgetStores(),
  };
}
