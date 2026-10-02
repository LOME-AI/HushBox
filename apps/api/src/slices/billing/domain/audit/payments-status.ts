import { rideOutSeconds } from '../../../../lib/jobs/backoff.js';
import { PAYMENT_VERIFY_DELAY_SECONDS, PAYMENT_VERIFY_MAX_FAILURES } from '../payments/payments.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { BillingStores } from '../../ports/index.js';

/**
 * The payments-status probe: rows the verify path was supposed to reach a
 * verdict on and did not. `awaiting_webhook` means the card was captured, so a
 * row aged out here is a user charged and never credited — and it is otherwise
 * invisible, because a dead-lettered verify job is neither `pending` nor
 * `running` and the jobs-health probe sees only those.
 *
 * Detection only, per the jobs doctrine: nothing here re-enqueues the verify
 * job, redrives a dead one, or transitions a row.
 */

/**
 * Slack past the verify path's own window before a row counts as stuck: one
 * auditor cadence, so a row whose window closed between passes is reported by
 * the next pass rather than early by the current one.
 */
export const PAYMENT_STATUS_AUDIT_GRACE_SECONDS = 60 * 60;

/**
 * The age past which a still-non-terminal row is a finding: the verify job's
 * scheduling delay, plus the retry budget's whole wall-clock span, plus the
 * grace margin. The ride-out is taken at its widest jitter, making the cutoff
 * an upper bound rather than an average — the auditor must not fire on a row
 * the dispatcher may still retry.
 *
 * Derived from {@link PAYMENT_VERIFY_MAX_FAILURES} and the shared backoff
 * curve, never written down: raising the budget widens this with it.
 */
export function unresolvedPaymentCutoff(now: Date): Date {
  const windowSeconds =
    PAYMENT_VERIFY_DELAY_SECONDS +
    rideOutSeconds(PAYMENT_VERIFY_MAX_FAILURES, () => 1) +
    PAYMENT_STATUS_AUDIT_GRACE_SECONDS;
  return new Date(now.getTime() - Math.round(windowSeconds * 1000));
}

export interface PaymentsStatusAuditFindings {
  /** How many rows are still non-terminal past the cutoff. */
  readonly unresolvedCount: number;
}

export function runPaymentsStatusAudit(
  stores: BillingStores,
  db: Database,
  now: Date
): ResultAsync<PaymentsStatusAuditFindings, DomainError> {
  return stores
    .countUnresolvedPayments(db, unresolvedPaymentCutoff(now))
    .map((unresolvedCount) => ({ unresolvedCount }));
}
