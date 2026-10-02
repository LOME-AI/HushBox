import type { AdminRole } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { AdminStores } from '../ports/index.js';

/**
 * The coarse read-audit actions (Charter #3/#12: sensitive reads are
 * audited) — one row per audited read, written on the request connection
 * rather than inside any transaction. Ordering is per member and no single
 * property decides it. A read that writes only once its lookup found the
 * entity (`customer360`, `feedbackView` — both return before the write on a
 * miss) would, by the row alone, confirm that the identifier names something
 * real, so it writes after that check and a miss records nothing and names no
 * one. Every other member's write is conditioned on nothing the read found:
 * each records only the read's own parameters, never a result, so the row
 * discloses only what the operator asked for. Of those, every one but
 * `dashboard` writes first, which is what keeps a read that then refuses or
 * fails on the record; `dashboard` writes after because its feed is a read of
 * `admin_audit` itself, so a row written first would be the newest row that
 * feed returns. Being unconditional, it still records a read that failed — a
 * request killed between the read and the write is what it no longer records.
 * Where the target came from does not decide any of this: `feedbackView` is
 * handed its id by the request and still writes after.
 *
 * `opRead` is a registered read operation's own row, written before the op's
 * body runs: the body reads and returns, so nothing it finds can condition the
 * row, and writing first keeps a read that then fails on the record.
 *
 * For `opPreview` that connection is load-bearing rather than incidental:
 * preview IS execute inside a settlement transaction the engine always rolls
 * back, so a row written on that transaction would roll back with the effects
 * it exists to record. Discarding the op body's writes is what makes preview
 * safe against production data, and the engine's own in-transaction audit row
 * is discarded with them — which is why the preview's record cannot be that
 * row.
 */
export const READ_AUDIT_ACTIONS = {
  customer360: 'read.customer360',
  sqlPanel: 'read.sqlPanel',
  feedbackView: 'read.feedbackView',
  newsletterSubscribers: 'read.newsletterSubscribers',
  jobQueue: 'read.jobQueue',
  dashboard: 'read.dashboard',
  opPreview: 'read.opPreview',
  opRead: 'read.op',
} as const;

interface ReadAuditEntry {
  readonly actor: string;
  readonly role: AdminRole;
  readonly action: (typeof READ_AUDIT_ACTIONS)[keyof typeof READ_AUDIT_ACTIONS];
  readonly targetType?: string;
  readonly targetId?: string;
  /** Wire-JSON read parameters (a 360 lookup's key kind, a SQL query text, a
   * previewed op and its input) — never results. */
  readonly details: Record<string, unknown>;
}

export async function writeReadAudit(
  stores: AdminStores,
  db: Database,
  entry: ReadAuditEntry
): Promise<{ id: string }> {
  return stores.insertAudit(db, entry);
}
