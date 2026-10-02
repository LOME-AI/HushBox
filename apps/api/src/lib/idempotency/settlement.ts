import { brandSettlementTx } from './brands.js';
import { grantJobWakes, runWithJobWakes } from '../jobs/wake-capability.js';
import type { Database } from '@hushbox/db';
import type { JobWakeCapable } from '../jobs/wake-capability.js';
import type { SettlementTx } from './brands.js';

/**
 * The settlement entry point. It and {@link runSettlementSavepoint}, which opens
 * only inside it, are the ONLY places a `SettlementTx` is minted.
 * Every money `*WithinTx` helper requires the branded handle, so
 * transactional composition is a capability handed down from here, never a
 * convention. The body runs in one interactive transaction: a throw rolls
 * back every write (nothing commits mid-run).
 *
 * A handle carrying the job-wake capability yields a transaction that carries
 * it too, and a plain handle yields a plain transaction. The overload pair is
 * what carries that distinction across this seam, so a consumer that demands a
 * capability-bearing writer refuses an ungranted transaction at compile time
 * instead of dropping the wake it would have left behind.
 */
export function runSettlement<T>(
  db: JobWakeCapable<Database>,
  body: (tx: JobWakeCapable<SettlementTx>) => Promise<T>
): Promise<T>;
export function runSettlement<T>(db: Database, body: (tx: SettlementTx) => Promise<T>): Promise<T>;
export async function runSettlement<T>(
  db: Database,
  body: (tx: JobWakeCapable<SettlementTx>) => Promise<T>
): Promise<T> {
  // Merge-on-commit, not a shared collector: nothing a previewed operation
  // enqueued and abandoned can wake a dispatcher.
  return await runWithJobWakes(db, (collected) =>
    db.transaction((tx) => body(grantJobWakes(brandSettlementTx(tx), collected)))
  );
}

/**
 * A savepoint inside an open settlement: a body that throws rolls back to it,
 * leaving the enclosing settlement's own writes in place and its transaction
 * usable, and a body that returns commits or rolls back with the settlement.
 * It opens only on a handle that already carries the settlement capability, so
 * the handle it hands down is still minted only from inside a settlement.
 * Job wakes merge on the same terms as {@link runSettlement}: into the
 * enclosing handle, only from a body that returned.
 */
export function runSettlementSavepoint<T>(
  tx: JobWakeCapable<SettlementTx>,
  body: (savepoint: JobWakeCapable<SettlementTx>) => Promise<T>
): Promise<T>;
export function runSettlementSavepoint<T>(
  tx: SettlementTx,
  body: (savepoint: SettlementTx) => Promise<T>
): Promise<T>;
export async function runSettlementSavepoint<T>(
  tx: SettlementTx,
  body: (savepoint: JobWakeCapable<SettlementTx>) => Promise<T>
): Promise<T> {
  return await runWithJobWakes(tx, (collected) =>
    tx.transaction((savepoint) => body(grantJobWakes(brandSettlementTx(savepoint), collected)))
  );
}
