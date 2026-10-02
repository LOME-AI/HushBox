import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createBackupAuditEntry, createBackupRetentionAuditEntry } from './entries.js';
import { BACKUP_VERSION_PAGE_LIMIT } from './backup-audit.js';
import type { BackupAuditDeps } from './entries.js';
import type {
  BackupLifecycleRule,
  BackupObjectVersion,
  BackupRepositoryReader,
  BackupVersionCursor,
  BackupVersionPage,
} from '../../ports/index.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

// The promised lifecycle duration, written out rather than imported: a fixture
// built from the constant the auditor compares against would agree with any
// value that constant took, and this rule is what the published retention
// ceiling rests on.
const PROMISED_RULES: readonly BackupLifecycleRule[] = [
  { prefix: 'repository/', noncurrentDays: 30 },
];

interface Recorder {
  readonly telemetry: Telemetry;
  readonly captures: { error: unknown; code: string }[];
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
}

function recordingTelemetry(): Recorder {
  const captures: Recorder['captures'] = [];
  const errors: Recorder['errors'] = [];
  return {
    captures,
    errors,
    telemetry: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, fields?: SafeLogFields) => {
        errors.push({ msg, fields });
      },
      captureError: (error: unknown, code: string) => {
        captures.push({ error, code });
      },
    },
  };
}

/** The fingerprint codes a run captured, in order. */
function codes(recorder: Recorder): string[] {
  return recorder.captures.map((capture) => capture.code);
}

/** The one error captured under `code`, having asserted there was exactly one. */
function soleCapture(recorder: Recorder, code: string): object {
  const matching = recorder.captures.filter((capture) => capture.code === code);
  expect(matching).toHaveLength(1);
  return matching[0]?.error as object;
}

interface ReaderStub {
  readonly newestAt?: Date | null;
  readonly rules?: readonly BackupLifecycleRule[];
  readonly listingFails?: boolean;
  readonly lifecycleFails?: boolean;
  /** One entry per page the version listing serves, in listing order. */
  readonly versionPages?: readonly BackupObjectVersion[][];
  /** Serves a fresh page forever, which is a repository larger than one pass can scan. */
  readonly versionsNeverEnd?: boolean;
  readonly versionsFail?: boolean;
}

function reader(stub: ReaderStub): BackupRepositoryReader {
  return {
    repositoryPrefix: 'repository/',
    newestSnapshotAt: () =>
      stub.listingFails === true
        ? errAsync(unavailableError('listing refused'))
        : okAsync(stub.newestAt ?? null),
    lifecycleRules: () =>
      stub.lifecycleFails === true
        ? errAsync(unavailableError('lifecycle read refused'))
        : okAsync(stub.rules ?? PROMISED_RULES),
    listObjectVersions: (cursor?: BackupVersionCursor) => {
      if (stub.versionsFail === true) return errAsync(unavailableError('version listing refused'));
      versionRequests.push(cursor);
      if (stub.versionsNeverEnd === true) {
        return okAsync({ versions: [], nextCursor: { keyMarker: 'endless' } });
      }
      const pages = stub.versionPages ?? [[]];
      const index = cursor === undefined ? 0 : Number(cursor.keyMarker);
      const page: BackupVersionPage = {
        versions: pages[index] ?? [],
        ...(index + 1 < pages.length ? { nextCursor: { keyMarker: String(index + 1) } } : {}),
      };
      return okAsync(page);
    },
  };
}

/** Every cursor the entry under test asked the reader for, in order. */
let versionRequests: (BackupVersionCursor | undefined)[] = [];

function auditDeps(stub: ReaderStub, telemetry: Telemetry): BackupAuditDeps {
  return { reader: reader(stub), telemetry, now: () => NOW };
}

async function run(stub: ReaderStub): Promise<Recorder> {
  const recorder = recordingTelemetry();
  await createBackupAuditEntry(() => auditDeps(stub, recorder.telemetry)).run();
  return recorder;
}

describe('createBackupAuditEntry', () => {
  it('is named for what it audits', () => {
    const entry = createBackupAuditEntry(() => auditDeps({}, recordingTelemetry().telemetry));

    expect(entry.name).toBe('backup-repository-audit');
  });

  it('records nothing when the newest snapshot is recent and the rule is right', async () => {
    const recorder = await run({ newestAt: new Date(NOW.getTime() - HOUR_MS) });

    expect(codes(recorder)).toEqual([]);
    expect(recorder.errors).toEqual([]);
  });

  it('captures a stale repository under the backup staleness code', async () => {
    const recorder = await run({ newestAt: new Date(NOW.getTime() - 9 * HOUR_MS) });

    expect(codes(recorder)).toEqual(['backup_stale']);
  });

  it('reports how stale the repository is in whole minutes', async () => {
    const recorder = await run({ newestAt: new Date(NOW.getTime() - 9 * HOUR_MS) });

    expect(recorder.errors[0]?.fields).toEqual({
      errorCode: 'backup_stale',
      ageMinutes: 540,
    });
  });

  it('captures a repository holding no snapshot under the same code', async () => {
    const recorder = await run({ newestAt: null });

    expect(codes(recorder)).toEqual(['backup_stale']);
  });

  it('reports no age for a repository that has no snapshot to age', async () => {
    const recorder = await run({ newestAt: null });

    expect(recorder.errors[0]?.fields).toEqual({ errorCode: 'backup_stale' });
  });

  it('carries how stale the repository is on the captured error, and nothing else', async () => {
    const recorder = await run({ newestAt: new Date(NOW.getTime() - 9 * HOUR_MS) });

    const error = soleCapture(recorder, 'backup_stale');
    // The whole key set, not a lookup of the one expected: the scrub admits
    // this tag on a bare number check rather than an enumeration, so what it
    // rests on is the producer emitting that number and nothing beside it.
    expect(Object.keys(error)).toEqual(['backupStaleMinutes']);
    expect(Reflect.get(error, 'backupStaleMinutes')).toBe(540);
  });

  it('carries no age on the captured error when there is no snapshot to age', async () => {
    const recorder = await run({ newestAt: null });

    expect(Object.keys(soleCapture(recorder, 'backup_stale'))).toEqual([]);
  });

  it('captures a listing failure as an unavailable audit, never as a healthy repository', async () => {
    const recorder = await run({ listingFails: true });

    expect(codes(recorder)).toEqual(['backup_audit_unavailable']);
  });

  it('captures a missing lifecycle rule as drift', async () => {
    const recorder = await run({ newestAt: NOW, rules: [] });

    expect(codes(recorder)).toEqual(['backup_lifecycle_drift']);
  });

  it('captures a lifecycle rule with a duration other than the promised one as drift', async () => {
    const recorder = await run({
      newestAt: NOW,
      rules: [{ prefix: 'repository/', noncurrentDays: 3650 }],
    });

    expect(codes(recorder)).toEqual(['backup_lifecycle_drift']);
  });

  it('carries the duration the drifted rule states on the captured error, and nothing else', async () => {
    const recorder = await run({
      newestAt: NOW,
      rules: [{ prefix: 'repository/', noncurrentDays: 3650 }],
    });

    const error = soleCapture(recorder, 'backup_lifecycle_drift');
    expect(Object.keys(error)).toEqual(['backupLifecycleNoncurrentDays']);
    expect(Reflect.get(error, 'backupLifecycleNoncurrentDays')).toBe(3650);
  });

  it('carries no duration on the captured error when no rule covers the repository', async () => {
    const recorder = await run({ newestAt: NOW, rules: [] });

    expect(Object.keys(soleCapture(recorder, 'backup_lifecycle_drift'))).toEqual([]);
  });

  it('captures a lifecycle read failure as an unavailable audit', async () => {
    const recorder = await run({ newestAt: NOW, lifecycleFails: true });

    expect(codes(recorder)).toEqual(['backup_audit_unavailable']);
  });

  it('reports both findings when the repository is stale and the rule has drifted', async () => {
    const recorder = await run({ newestAt: new Date(NOW.getTime() - 9 * HOUR_MS), rules: [] });

    expect(new Set(codes(recorder))).toEqual(new Set(['backup_stale', 'backup_lifecycle_drift']));
  });

  it('reports the lifecycle finding even when the snapshot listing is unreadable', async () => {
    const recorder = await run({ listingFails: true, rules: [] });

    expect(new Set(codes(recorder))).toEqual(
      new Set(['backup_audit_unavailable', 'backup_lifecycle_drift'])
    );
  });

  it('resolves its dependencies inside the run, so a missing binding fails this entry alone', async () => {
    const entry = createBackupAuditEntry(() => {
      throw new Error('BACKUP_B2_BUCKET is required');
    });

    expect(entry.name).toBe('backup-repository-audit');
    await expect(entry.run()).rejects.toThrow('BACKUP_B2_BUCKET');
  });
});

const DAY_MS = 24 * HOUR_MS;

function at(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * DAY_MS);
}

function version(key: string, uploadedDaysAgo: number): BackupObjectVersion {
  return { key, lastModified: at(uploadedDaysAgo) };
}

async function runRetention(stub: ReaderStub): Promise<Recorder> {
  const recorder = recordingTelemetry();
  versionRequests = [];
  await createBackupRetentionAuditEntry(() => auditDeps(stub, recorder.telemetry)).run();
  return recorder;
}

describe('createBackupRetentionAuditEntry', () => {
  it('is named for what it audits', () => {
    const entry = createBackupRetentionAuditEntry(() =>
      auditDeps({}, recordingTelemetry().telemetry)
    );

    expect(entry.name).toBe('backup-retention-audit');
  });

  it('records nothing for a repository whose hidden versions are being destroyed', async () => {
    const recorder = await runRetention({
      versionPages: [[version('repository/data/aa', 1), version('repository/data/aa', 400)]],
    });

    expect(codes(recorder)).toEqual([]);
    expect(recorder.errors).toEqual([]);
  });

  it('records nothing for a version that is old but still the current one', async () => {
    // The window runs from when a version stopped being current, and a backup
    // pack legitimately stays current for months. Judging on upload age would
    // fire on this healthy repository every single day.
    const recorder = await runRetention({
      versionPages: [[version('repository/data/aa', 400), version('repository/data/bb', 300)]],
    });

    expect(codes(recorder)).toEqual([]);
  });

  it('captures a version left past the retention window under the overdue code', async () => {
    const recorder = await runRetention({
      versionPages: [[version('repository/data/aa', 41), version('repository/data/aa', 400)]],
    });

    expect(codes(recorder)).toEqual(['backup_retention_overdue']);
  });

  it('carries how long the version has been noncurrent on the captured error, and nothing else', async () => {
    const recorder = await runRetention({
      versionPages: [[version('repository/data/aa', 41), version('repository/data/aa', 400)]],
    });

    const error = soleCapture(recorder, 'backup_retention_overdue');
    // The whole key set, not a lookup of the one expected: the scrub admits
    // this tag on a bare number check rather than an enumeration, so what it
    // rests on is the producer emitting that number and nothing beside it.
    expect(Object.keys(error)).toEqual(['backupNoncurrentVersionDays']);
    expect(Reflect.get(error, 'backupNoncurrentVersionDays')).toBe(41);
  });

  it('draws every page of a clean listing before reporting nothing', async () => {
    const recorder = await runRetention({
      versionPages: [
        [version('repository/data/aa', 400)],
        [version('repository/data/bb', 300)],
        [version('repository/data/cc', 1)],
      ],
    });

    expect(codes(recorder)).toEqual([]);
    expect(versionRequests).toHaveLength(3);
  });

  it('dates a version split across a page boundary from the entry on the previous page', async () => {
    const recorder = await runRetention({
      versionPages: [[version('repository/data/aa', 41)], [version('repository/data/aa', 400)]],
    });

    expect(codes(recorder)).toEqual(['backup_retention_overdue']);
  });

  it('stops at the first offending page instead of draining the whole listing', async () => {
    await runRetention({
      versionPages: [
        [version('repository/data/aa', 41), version('repository/data/aa', 400)],
        [version('repository/data/bb', 1)],
        [version('repository/data/cc', 1)],
      ],
    });

    expect(versionRequests).toHaveLength(1);
  });

  it('captures an unfinished listing as unscanned, never as a clean repository', async () => {
    const recorder = await runRetention({ versionsNeverEnd: true });

    expect(codes(recorder)).toEqual(['backup_retention_unscanned']);
  });

  it('bounds an unfinished listing at the page budget rather than paging forever', async () => {
    await runRetention({ versionsNeverEnd: true });

    expect(versionRequests).toHaveLength(BACKUP_VERSION_PAGE_LIMIT);
  });

  it('captures a refused version listing as an unavailable audit', async () => {
    const recorder = await runRetention({ versionsFail: true });

    expect(codes(recorder)).toEqual(['backup_audit_unavailable']);
  });

  it('resolves its dependencies inside the run, so a missing binding fails this entry alone', async () => {
    const entry = createBackupRetentionAuditEntry(() => {
      throw new Error('BACKUP_B2_BUCKET is required');
    });

    expect(entry.name).toBe('backup-retention-audit');
    await expect(entry.run()).rejects.toThrow('BACKUP_B2_BUCKET');
  });
});
