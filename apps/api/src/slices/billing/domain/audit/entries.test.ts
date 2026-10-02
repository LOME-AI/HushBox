import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import {
  createLedgerConservationEntry,
  createPaymentsStatusAuditEntry,
  createSnapshotDriftEntry,
} from './entries.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type { WalletSnapshotComparison } from './auditors.js';

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly warns: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const warns: TelemetryRecorder['warns'] = [];
  const captured: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    captureError: (_error, code: string) => {
      captured.push(code);
    },
  };
  return { telemetry, errors, warns, captured };
}

function comparison(overrides: Partial<WalletSnapshotComparison>): WalletSnapshotComparison {
  return {
    walletId: crypto.randomUUID(),
    snapshotBalanceNanoUsd: 100n,
    ledgerBalanceNanoUsd: 100n,
    driftNanoUsd: 0n,
    snapshotLedgerSeq: 1n,
    walletLedgerSeq: 1n,
    ...overrides,
  };
}

describe('createLedgerConservationEntry', () => {
  it('pages on an unbalanced transaction', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () =>
        okAsync({
          unbalancedTransactions: [{ transactionId: crypto.randomUUID(), totalNanoUsd: -7n }],
          walletDrift: [],
        }),
      telemetry: recorder.telemetry,
    });
    expect(entry.name).toBe('ledger-conservation-audit');
    await entry.run();
    expect(recorder.captured).toEqual(['ledger_conservation_unbalanced']);
  });

  it('pages on wallet balance drift', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () =>
        okAsync({
          unbalancedTransactions: [],
          walletDrift: [{ walletId: crypto.randomUUID(), balanceNanoUsd: 5n, legSumNanoUsd: 0n }],
        }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual(['ledger_wallet_balance_drift']);
  });

  it('stays silent on a conserved ledger', async () => {
    const recorder = recordingTelemetry();
    const entry = createLedgerConservationEntry({
      audit: () => okAsync({ unbalancedTransactions: [], walletDrift: [] }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.errors).toEqual([]);
  });

  it('propagates an audit failure to the entry runner', async () => {
    const entry = createLedgerConservationEntry({
      audit: () => errAsync(unavailableError('db down')),
      telemetry: recordingTelemetry().telemetry,
    });
    await expect(entry.run()).rejects.toThrow('unavailable');
  });
});

describe('createSnapshotDriftEntry', () => {
  it('pages when a snapshot sequence is ahead of the ledger', async () => {
    const recorder = recordingTelemetry();
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 9n, walletLedgerSeq: 3n, driftNanoUsd: 0n })),
      telemetry: recorder.telemetry,
    });
    expect(entry.name).toBe('wallet-snapshot-drift-audit');
    await entry.run();
    expect(recorder.captured).toEqual(['wallet_snapshot_seq_ahead']);
    expect(recorder.warns).toEqual([]);
  });

  it('warns per drifted wallet at digest level', async () => {
    const recorder = recordingTelemetry();
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 1n, walletLedgerSeq: 2n, driftNanoUsd: -300n })),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.warns).toEqual([
      {
        msg: 'wallet snapshot balance drifted from the ledger',
        fields: { errorCode: 'wallet_snapshot_drift' },
      },
    ]);
  });

  it('pages exactly once per pass however many wallets drifted', async () => {
    const recorder = recordingTelemetry();
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a', 'wallet-b']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 1n, walletLedgerSeq: 2n, driftNanoUsd: -300n })),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.warns).toHaveLength(2);
    expect(recorder.captured).toEqual(['wallet_snapshot_drift']);
  });

  it('pages with a content-free message on snapshot drift', async () => {
    const messages: string[] = [];
    const recorder = recordingTelemetry();
    const telemetry: Telemetry = {
      ...recorder.telemetry,
      captureError: (error: Error) => {
        messages.push(error.message);
      },
    };
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a']),
      compare: () =>
        okAsync(comparison({ snapshotLedgerSeq: 1n, walletLedgerSeq: 2n, driftNanoUsd: -300n })),
      telemetry,
    });
    await entry.run();
    expect(messages).toEqual(['wallet snapshots drifted from the ledger']);
  });

  it('stays silent on aligned snapshots and skips missing ones', async () => {
    const recorder = recordingTelemetry();
    let calls = 0;
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a', 'wallet-b']),
      compare: () => {
        calls += 1;
        return calls === 1 ? okAsync(comparison({})) : okAsync(null);
      },
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.warns).toEqual([]);
  });

  it('contains a single wallet audit failure and keeps auditing the rest', async () => {
    const recorder = recordingTelemetry();
    const audited: string[] = [];
    const entry = createSnapshotDriftEntry({
      listWalletIds: () => okAsync(['wallet-a', 'wallet-b']),
      compare: (walletId) => {
        audited.push(walletId);
        return walletId === 'wallet-a'
          ? errAsync(unavailableError('redis blip'))
          : okAsync(comparison({}));
      },
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(audited).toEqual(['wallet-a', 'wallet-b']);
    expect(recorder.captured).toEqual(['wallet_snapshot_audit_failed']);
  });
});

describe('createPaymentsStatusAuditEntry', () => {
  it('pages when rows are left non-terminal past the verify window', async () => {
    const recorder = recordingTelemetry();
    const entry = createPaymentsStatusAuditEntry({
      audit: () => okAsync({ unresolvedCount: 1 }),
      telemetry: recorder.telemetry,
    });
    expect(entry.name).toBe('payments-status-audit');
    await entry.run();
    expect(recorder.captured).toEqual(['payment_unresolved_past_verify_window']);
    expect(recorder.errors).toEqual([
      {
        msg: 'payments remain non-terminal past the verify window',
        fields: { errorCode: 'payment_unresolved_past_verify_window' },
      },
    ]);
  });

  it('pages exactly once per pass however many rows aged out', async () => {
    // A vendor outage strands rows in bulk; one alert per row would bury the
    // one repair a human has to make under its own duplicates.
    const recorder = recordingTelemetry();
    const entry = createPaymentsStatusAuditEntry({
      audit: () => okAsync({ unresolvedCount: 47 }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual(['payment_unresolved_past_verify_window']);
    expect(recorder.errors).toHaveLength(1);
  });

  it('stays silent when every row reached a verdict in time', async () => {
    const recorder = recordingTelemetry();
    const entry = createPaymentsStatusAuditEntry({
      audit: () => okAsync({ unresolvedCount: 0 }),
      telemetry: recorder.telemetry,
    });
    await entry.run();
    expect(recorder.captured).toEqual([]);
    expect(recorder.errors).toEqual([]);
  });

  it('surfaces a failed probe rather than reporting a clean pass', async () => {
    const entry = createPaymentsStatusAuditEntry({
      audit: () => errAsync(unavailableError('postgres blip')),
      telemetry: recordingTelemetry().telemetry,
    });
    await expect(entry.run()).rejects.toThrow();
  });
});
