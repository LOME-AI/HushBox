import { runOrThrow } from '../../../../lib/jobs/index.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { ConservationAuditFindings, WalletSnapshotComparison } from './auditors.js';
import type { PaymentsStatusAuditFindings } from './payments-status.js';
import type { CronEntry } from '../../../../lib/jobs/index.js';

/**
 * The hourly billing auditors: read-only detection, Sentry-visible paging
 * for invariant violations, warn-level (daily-digest) logs for routine
 * drift. Repair is explicit human action — nothing here mutates domain
 * state. Finding details (which transaction, which wallet) live in the
 * database the page points a human at; the telemetry channel carries codes
 * and counts, never row payloads.
 */

export interface ConservationAuditEntryDeps {
  readonly audit: () => ResultAsync<ConservationAuditFindings, DomainError>;
  readonly telemetry: Telemetry;
}

export function createLedgerConservationEntry(deps: ConservationAuditEntryDeps): CronEntry {
  return {
    name: 'ledger-conservation-audit',
    run: async (): Promise<void> => {
      const findings = await runOrThrow(deps.audit());
      if (findings.unbalancedTransactions.length > 0) {
        deps.telemetry.error('ledger conservation audit found unbalanced transactions', {
          errorCode: 'ledger_conservation_unbalanced',
        });
        deps.telemetry.captureError(
          new Error('ledger conservation audit found unbalanced transactions'),
          FINGERPRINT_CODES.ledgerConservationUnbalanced
        );
      }
      if (findings.walletDrift.length > 0) {
        deps.telemetry.error('ledger conservation audit found wallet balance drift', {
          errorCode: 'ledger_wallet_balance_drift',
        });
        deps.telemetry.captureError(
          new Error('ledger conservation audit found wallet balance drift'),
          FINGERPRINT_CODES.ledgerWalletBalanceDrift
        );
      }
    },
  };
}

export interface SnapshotDriftEntryDeps {
  readonly listWalletIds: () => ResultAsync<readonly string[], DomainError>;
  readonly compare: (walletId: string) => ResultAsync<WalletSnapshotComparison | null, DomainError>;
  readonly telemetry: Telemetry;
}

export function createSnapshotDriftEntry(deps: SnapshotDriftEntryDeps): CronEntry {
  return {
    name: 'wallet-snapshot-drift-audit',
    run: async (): Promise<void> => {
      const walletIds = await runOrThrow(deps.listWalletIds());
      let drifted = false;
      for (const walletId of walletIds) {
        // Contained per wallet: one malformed snapshot must not hide the
        // remaining wallets from this pass.
        const compared = await deps.compare(walletId);
        if (compared.isErr()) {
          deps.telemetry.captureError(
            new Error(compared.error.code, { cause: compared.error }),
            FINGERPRINT_CODES.walletSnapshotAuditFailed
          );
          continue;
        }
        const comparison = compared.value;
        if (comparison === null) continue;
        if (comparison.snapshotLedgerSeq > comparison.walletLedgerSeq) {
          // Impossible by construction (the write-through CASes on the
          // ledger sequence) — a page, not digest drift.
          deps.telemetry.error('wallet snapshot ledger sequence is ahead of the ledger', {
            errorCode: 'wallet_snapshot_seq_ahead',
          });
          deps.telemetry.captureError(
            new Error('wallet snapshot ledger sequence is ahead of the ledger'),
            FINGERPRINT_CODES.walletSnapshotSeqAhead
          );
          continue;
        }
        if (comparison.driftNanoUsd !== 0n) {
          drifted = true;
          deps.telemetry.warn('wallet snapshot balance drifted from the ledger', {
            errorCode: FINGERPRINT_CODES.walletSnapshotDrift,
          });
        }
      }
      // Detection without a page is an auditor nobody hears, so the pass that
      // found drift rings once — a page per drifted row would turn one repair
      // into a storm of duplicates.
      if (drifted) {
        deps.telemetry.captureError(
          new Error('wallet snapshots drifted from the ledger'),
          FINGERPRINT_CODES.walletSnapshotDrift
        );
      }
    },
  };
}

export interface PaymentsStatusAuditEntryDeps {
  readonly audit: () => ResultAsync<PaymentsStatusAuditFindings, DomainError>;
  readonly telemetry: Telemetry;
}

export function createPaymentsStatusAuditEntry(deps: PaymentsStatusAuditEntryDeps): CronEntry {
  return {
    name: 'payments-status-audit',
    run: async (): Promise<void> => {
      const findings = await runOrThrow(deps.audit());
      if (findings.unresolvedCount === 0) return;
      // One ring for the whole pass, whatever the count: a provider outage
      // strands rows in bulk, and an alert per row would bury the single
      // repair a human has to make. Which rows they are is a query against the
      // database this points at — the telemetry channel carries no row payload.
      deps.telemetry.error('payments remain non-terminal past the verify window', {
        errorCode: 'payment_unresolved_past_verify_window',
      });
      deps.telemetry.captureError(
        new Error('payments remain non-terminal past the verify window'),
        FINGERPRINT_CODES.paymentUnresolvedPastVerifyWindow
      );
    },
  };
}
