import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { BACKUP_LIFECYCLE_NONCURRENT_DAYS } from '../../ports/index.js';
import {
  BACKUP_STALENESS_TOLERANCE_MS,
  BACKUP_SWEEP_GRACE_DAYS,
  judgeLifecycleRules,
  judgeNoncurrentVersions,
  judgeSnapshotFreshness,
  scanVersionPage,
} from './backup-audit.js';
import type { BackupRetention, BackupVersionScan } from './backup-audit.js';
import type { BackupLifecycleRule, BackupObjectVersion } from '../../ports/index.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

describe('judgeSnapshotFreshness', () => {
  it('reports a snapshot inside the tolerance as fresh', () => {
    const newest = new Date(NOW.getTime() - BACKUP_STALENESS_TOLERANCE_MS + MINUTE_MS);
    expect(judgeSnapshotFreshness(newest, NOW)).toEqual({ kind: 'fresh' });
  });

  it('reports a snapshot exactly at the tolerance as fresh', () => {
    const newest = new Date(NOW.getTime() - BACKUP_STALENESS_TOLERANCE_MS);
    expect(judgeSnapshotFreshness(newest, NOW)).toEqual({ kind: 'fresh' });
  });

  it('reports a snapshot past the tolerance as stale with its age in whole minutes', () => {
    const newest = new Date(NOW.getTime() - (5 * HOUR_MS + 30 * MINUTE_MS));
    expect(judgeSnapshotFreshness(newest, NOW)).toEqual({ kind: 'stale', ageMinutes: 330 });
  });

  it('floors a fractional age rather than rounding it up', () => {
    const newest = new Date(NOW.getTime() - (4 * HOUR_MS + 59 * MINUTE_MS + 59_000));
    expect(judgeSnapshotFreshness(newest, NOW)).toEqual({ kind: 'stale', ageMinutes: 299 });
  });

  it('reports a repository holding no snapshot as empty', () => {
    expect(judgeSnapshotFreshness(null, NOW)).toEqual({ kind: 'empty' });
  });
});

describe('judgeLifecycleRules', () => {
  // The promised duration is written out here rather than read from the
  // constant the judgement uses: a fixture built from the value under test
  // would agree with any value that value took.
  function rule(overrides: Partial<BackupLifecycleRule>): BackupLifecycleRule {
    return { prefix: 'repository/', noncurrentDays: 30, ...overrides };
  }

  it('accepts a rule covering the repository prefix with the promised duration', () => {
    expect(judgeLifecycleRules([rule({})], 'repository/')).toEqual({ kind: 'correct' });
  });

  it('accepts a bucket-wide rule with the promised duration', () => {
    expect(judgeLifecycleRules([rule({ prefix: '' })], 'repository/')).toEqual({ kind: 'correct' });
  });

  it('reports an empty rule set as absent', () => {
    expect(judgeLifecycleRules([], 'repository/')).toEqual({ kind: 'absent' });
  });

  it('reports a rule set covering only a deeper prefix as absent', () => {
    expect(judgeLifecycleRules([rule({ prefix: 'repository/snapshots/' })], 'repository/')).toEqual(
      { kind: 'absent' }
    );
  });

  it('reports a rule set covering a different prefix as absent', () => {
    expect(judgeLifecycleRules([rule({ prefix: 'elsewhere/' })], 'repository/')).toEqual({
      kind: 'absent',
    });
  });

  it('reports a covering rule that destroys no version as absent', () => {
    const noExpiry: BackupLifecycleRule = { prefix: 'repository/' };
    expect(judgeLifecycleRules([noExpiry], 'repository/')).toEqual({ kind: 'absent' });
  });

  it('reports a longer duration than promised as drift, naming the duration found', () => {
    expect(judgeLifecycleRules([rule({ noncurrentDays: 3650 })], 'repository/')).toEqual({
      kind: 'wrongDuration',
      noncurrentDays: 3650,
    });
  });

  it('reports a shorter duration than promised as drift', () => {
    expect(judgeLifecycleRules([rule({ noncurrentDays: 7 })], 'repository/')).toEqual({
      kind: 'wrongDuration',
      noncurrentDays: 7,
    });
  });

  it('judges overlapping rules on the shortest duration, which is the one the store applies', () => {
    const rules = [rule({ prefix: '' }), rule({ noncurrentDays: 7 })];
    expect(judgeLifecycleRules(rules, 'repository/')).toEqual({
      kind: 'wrongDuration',
      noncurrentDays: 7,
    });
  });

  it('ignores a non-covering rule when judging the effective duration', () => {
    const rules = [rule({}), rule({ prefix: 'elsewhere/', noncurrentDays: 1 })];
    expect(judgeLifecycleRules(rules, 'repository/')).toEqual({ kind: 'correct' });
  });
});

describe('the promised retention values', () => {
  it('tolerates one missed hourly run plus scheduler jitter', () => {
    expect(BACKUP_STALENESS_TOLERANCE_MS).toBe(3 * HOUR_MS);
  });

  it('pins the lifecycle duration the published retention ceiling is computed from', () => {
    expect(BACKUP_LIFECYCLE_NONCURRENT_DAYS).toBe(30);
  });
});

describe('scanVersionPage', () => {
  const DAY_MS = 24 * HOUR_MS;

  function at(daysAgo: number): Date {
    return new Date(NOW.getTime() - daysAgo * DAY_MS);
  }

  /** One listing entry: a version or a delete marker, as the store reports it. */
  function version(key: string, uploadedDaysAgo: number): BackupObjectVersion {
    return { key, lastModified: at(uploadedDaysAgo) };
  }

  /** The scan of a whole listing, fed one page at a time. */
  function scanAll(...pages: BackupObjectVersion[][]): BackupVersionScan {
    let scan: BackupVersionScan = {};
    for (const page of pages) scan = scanVersionPage(page, scan);
    return scan;
  }

  it('finds nothing noncurrent in a listing whose keys each hold one version', () => {
    expect(scanAll([version('a', 400), version('b', 300), version('c', 1)])).toEqual({
      previous: { key: 'c', at: at(1) },
    });
  });

  it('dates a noncurrent version from the next-newer version of the same key', () => {
    // The older entry stopped being current when the newer one landed, which is
    // 41 days ago — not when it was itself uploaded 400 days ago.
    expect(scanAll([version('a', 41), version('a', 400)]).oldestNoncurrentSince).toEqual(at(41));
  });

  it('dates a noncurrent version from a delete marker above it, which is an entry like any other', () => {
    expect(scanAll([version('a', 41), version('a', 90)]).oldestNoncurrentSince).toEqual(at(41));
  });

  it('keeps the oldest noncurrent-since when a key holds several noncurrent versions', () => {
    // The middle entry went noncurrent 41 days ago and the bottom one 50 days
    // ago, so the oldest of the two is what the scan carries.
    expect(scanAll([version('a', 41), version('a', 50), version('a', 60)])).toMatchObject({
      oldestNoncurrentSince: at(50),
    });
  });

  it('carries the trailing entry across a page boundary rather than restarting the key', () => {
    expect(scanAll([version('a', 41)], [version('a', 400)]).oldestNoncurrentSince).toEqual(at(41));
  });

  it('never dates the first version of a key from the entry before it', () => {
    expect(scanAll([version('a', 1)], [version('b', 400)]).oldestNoncurrentSince).toBeUndefined();
  });
});

describe('judgeNoncurrentVersions', () => {
  const DAY_MS = 24 * HOUR_MS;

  function at(daysAgo: number): Date {
    return new Date(NOW.getTime() - daysAgo * DAY_MS);
  }

  function version(key: string, uploadedDaysAgo: number): BackupObjectVersion {
    return { key, lastModified: at(uploadedDaysAgo) };
  }

  function judgeAll(...pages: BackupObjectVersion[][]): BackupRetention {
    let scan: BackupVersionScan = {};
    for (const page of pages) scan = scanVersionPage(page, scan);
    return judgeNoncurrentVersions(scan, NOW);
  }

  it('reports a repository of current versions as clean, however old they are', () => {
    expect(judgeAll([version('a', 400), version('b', 300)])).toEqual({ kind: 'clean' });
  });

  it('reports an old version that is still the current one as clean', () => {
    // A backup pack legitimately stays current for months. Judging on upload
    // age would alarm on this every single day.
    expect(judgeAll([version('a', 400)])).toEqual({ kind: 'clean' });
  });

  it('reports an ancient version hidden only yesterday as clean', () => {
    expect(judgeAll([version('a', 1), version('a', 400)])).toEqual({ kind: 'clean' });
  });

  it('reports a version that went noncurrent past the window as overdue, in whole days', () => {
    expect(judgeAll([version('a', 41), version('a', 400)])).toEqual({
      kind: 'overdue',
      noncurrentDays: 41,
    });
  });

  it('reports a version that went noncurrent exactly at the deadline as clean', () => {
    const deadlineDays = BACKUP_LIFECYCLE_NONCURRENT_DAYS + BACKUP_SWEEP_GRACE_DAYS;
    expect(judgeAll([version('a', deadlineDays), version('a', 400)])).toEqual({ kind: 'clean' });
  });

  it('reports a version one day past the deadline as overdue', () => {
    const pastDeadline = BACKUP_LIFECYCLE_NONCURRENT_DAYS + BACKUP_SWEEP_GRACE_DAYS + 1;
    expect(judgeAll([version('a', pastDeadline), version('a', 400)])).toEqual({
      kind: 'overdue',
      noncurrentDays: pastDeadline,
    });
  });

  it('reports a listing that held no version at all as clean', () => {
    expect(judgeNoncurrentVersions({}, NOW)).toEqual({ kind: 'clean' });
  });
});

describe('the sweep tolerance', () => {
  it('exceeds the vendor sweep cadence the lifecycle rule is applied on', () => {
    expect(BACKUP_SWEEP_GRACE_DAYS).toBe(7);
  });

  it('leaves the audit deadline well inside the published retention ceiling', () => {
    // The published ceiling is 90 days; the deadline is what this audit calls
    // overdue, so it must bite with room to repair rather than at the promise.
    expect(BACKUP_LIFECYCLE_NONCURRENT_DAYS + BACKUP_SWEEP_GRACE_DAYS).toBeLessThan(90);
  });
});
