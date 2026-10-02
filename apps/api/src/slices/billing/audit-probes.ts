import {
  compareSnapshotToLedger,
  listSnapshotWalletIds,
  runConservationAudit,
} from './domain/audit/auditors.js';
import { runPaymentsStatusAudit } from './domain/audit/payments-status.js';
import { createBillingStores } from './adapters/stores.js';
import type { Database } from '@hushbox/db';
import type { RedisClient } from './domain/keys.js';
import type {
  ConservationAuditEntryDeps,
  PaymentsStatusAuditEntryDeps,
  SnapshotDriftEntryDeps,
} from './domain/audit/entries.js';

/**
 * The seam that binds billing's published read-only audit queries to live
 * infra handles for the hourly cron. Billing's domain cannot reach its own
 * adapter for the stores, and the adapter cannot reach the domain queries —
 * this slice-root module is where the two meet (`chat/conversation-runtime.ts`
 * precedent).
 */

interface BillingAuditProbes {
  readonly audit: ConservationAuditEntryDeps['audit'];
  readonly listWalletIds: SnapshotDriftEntryDeps['listWalletIds'];
  readonly compare: SnapshotDriftEntryDeps['compare'];
  readonly auditPaymentsStatus: PaymentsStatusAuditEntryDeps['audit'];
}

/** Binds the published billing audit queries to live infra handles. */
export function createBillingAuditProbes(
  db: Database,
  redis: RedisClient,
  now: () => Date
): BillingAuditProbes {
  const stores = createBillingStores();
  return {
    audit: () => runConservationAudit(stores, db),
    listWalletIds: () => listSnapshotWalletIds(redis),
    compare: (walletId) => compareSnapshotToLedger({ redis, db, stores }, walletId),
    auditPaymentsStatus: () => runPaymentsStatusAudit(stores, db, now()),
  };
}
