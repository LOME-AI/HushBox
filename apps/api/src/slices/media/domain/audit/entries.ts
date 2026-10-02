import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import {
  BACKUP_VERSION_PAGE_LIMIT,
  judgeLifecycleRules,
  judgeNoncurrentVersions,
  judgeSnapshotFreshness,
  scanVersionPage,
} from './backup-audit.js';
import type { BackupVersionScan } from './backup-audit.js';
import type { BackupRepositoryReader, BackupVersionCursor } from '../../ports/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { CronEntry } from '../../../../lib/jobs/index.js';

/**
 * The backup-repository auditor: read-only detection of the two ways the
 * backup can fail silently, both of which nothing else in the system can see.
 *
 * The backup itself runs on a schedule outside this Worker, and a schedule that
 * stops firing raises nothing where it lives — so a repository that stopped
 * growing is visible only to something that looks. The bucket's lifecycle rule
 * is the same shape of blind spot on the other end: the backup credential holds
 * no destroy capability, so removing an object only hides a version and that
 * rule is the single stage of the deletion chain that erases anything. A rule
 * that is absent or set to the wrong duration keeps deleted user data past the
 * ceiling the privacy policy publishes, with nothing else noticing.
 *
 * Repair is a human re-running the backup workflow or fixing the bucket; this
 * entry writes nothing anywhere.
 */

export interface BackupAuditDeps {
  readonly reader: BackupRepositoryReader;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
}

async function auditFreshness(deps: BackupAuditDeps): Promise<void> {
  const newest = await deps.reader.newestSnapshotAt();
  if (newest.isErr()) {
    deps.telemetry.captureError(
      new Error(newest.error.code, { cause: newest.error }),
      FINGERPRINT_CODES.backupAuditUnavailable
    );
    return;
  }
  const finding = judgeSnapshotFreshness(newest.value, deps.now());
  if (finding.kind === 'fresh') return;
  deps.telemetry.error('backup repository has no recent snapshot', {
    errorCode: FINGERPRINT_CODES.backupStale,
    ...(finding.kind === 'stale' ? { ageMinutes: finding.ageMinutes } : {}),
  });
  const error = new Error('backup repository has no recent snapshot');
  if (finding.kind === 'stale') {
    // How stale rides as a property because the Sentry scrub drops the message
    // and rebuilds the event from an allowlist; `sentry-scrub.ts` lifts this
    // key into a tag. One missed run and a workflow that stopped days ago
    // raise the same code and want different repairs, and the retained channel
    // is the only one that carries either to an operator. A repository holding
    // no snapshot has no age, so it carries none.
    Object.assign(error, { backupStaleMinutes: finding.ageMinutes });
  }
  deps.telemetry.captureError(error, FINGERPRINT_CODES.backupStale);
}

async function auditLifecycle(deps: BackupAuditDeps): Promise<void> {
  const rules = await deps.reader.lifecycleRules();
  if (rules.isErr()) {
    deps.telemetry.captureError(
      new Error(rules.error.code, { cause: rules.error }),
      FINGERPRINT_CODES.backupAuditUnavailable
    );
    return;
  }
  const finding = judgeLifecycleRules(rules.value, deps.reader.repositoryPrefix);
  if (finding.kind === 'correct') return;
  deps.telemetry.error('backup bucket retention rule does not match the published ceiling', {
    errorCode: FINGERPRINT_CODES.backupLifecycleDrift,
  });
  const error = new Error('backup bucket retention rule does not match the published ceiling');
  if (finding.kind === 'wrongDuration') {
    // What the rule actually states rides as a property, the way the staleness
    // age does: a page saying the duration is wrong without saying what it is
    // cannot tell a rule someone widened by a day from one set to ten years.
    // An absent rule states nothing, so it carries nothing.
    Object.assign(error, { backupLifecycleNoncurrentDays: finding.noncurrentDays });
  }
  deps.telemetry.captureError(error, FINGERPRINT_CODES.backupLifecycleDrift);
}

export function createBackupAuditEntry(resolve: () => BackupAuditDeps): CronEntry {
  return {
    name: 'backup-repository-audit',
    // Deps resolve inside the run so a missing binding fails this entry alone
    // (the runner captures it) and never its cadence siblings.
    run: async (): Promise<void> => {
      const deps = resolve();
      // Both checks always run: an unreadable listing must not hide a lifecycle
      // rule that has drifted, which is the finding with no other witness.
      await Promise.all([auditFreshness(deps), auditLifecycle(deps)]);
    },
  };
}

/**
 * The retention auditor: read-only detection that hidden versions are actually
 * being erased, which is the last stage of the deletion chain and the only one
 * that destroys anything.
 *
 * It exists because the bucket's lifecycle rule reading back correct does not
 * mean the rule is erasing. A retention lock set on the bucket from the vendor
 * console stops every deletion while leaving both other backup checks green —
 * snapshots stay fresh, the rule still states the promised duration — so
 * deleted user data would be kept indefinitely with nothing saying so. The lock
 * itself cannot be read: doing so needs a vendor capability this auditor's
 * credential deliberately does not hold, and widening that credential would let
 * a stolen key draw the whole encrypted corpus. So the check observes the
 * effect instead of the configuration, which also catches a rule that silently
 * stopped applying and a vendor sweep that stalled.
 *
 * Its blind spot, which nothing in this system currently covers: it detects
 * erasure stopping, not MARKING stopping. If the backup's own retention pass
 * stops running, no version ever becomes noncurrent, no old version exists to
 * find, and this check reads healthy — and snapshot freshness does not cover it
 * either, because a fresh snapshot does not imply a retention pass ran. That
 * gap is known and open, not assumed away.
 *
 * It runs on the daily pass rather than the hourly one because the healthy case
 * is the expensive one (a violation stops at the first offender; a clean
 * repository pays for a full paged listing) and what it detects moves on a
 * scale of days, so an hourly cadence would spend twenty-four times the listing
 * budget to learn the same fact.
 */
async function auditRetention(deps: BackupAuditDeps): Promise<void> {
  let scan: BackupVersionScan = {};
  let cursor: BackupVersionCursor | undefined;
  for (let page = 0; page < BACKUP_VERSION_PAGE_LIMIT; page += 1) {
    const listed = await deps.reader.listObjectVersions(cursor);
    if (listed.isErr()) {
      deps.telemetry.captureError(
        new Error(listed.error.code, { cause: listed.error }),
        FINGERPRINT_CODES.backupAuditUnavailable
      );
      return;
    }
    scan = scanVersionPage(listed.value.versions, scan);
    const finding = judgeNoncurrentVersions(scan, deps.now());
    if (finding.kind === 'overdue') {
      deps.telemetry.error('backup bucket still holds a version past the retention window', {
        errorCode: FINGERPRINT_CODES.backupRetentionOverdue,
      });
      const error = new Error('backup bucket still holds a version past the retention window');
      // How far past the window rides as a property because the Sentry scrub
      // drops the message and rebuilds the event from an allowlist;
      // `sentry-scrub.ts` lifts this key into a tag. A version a day past the
      // window and one a year past it raise the same code and want different
      // urgency, and the retained channel is the only one that carries either
      // to an operator. The object's key names nothing here: it would be the
      // one field on this path that could carry content.
      Object.assign(error, { backupNoncurrentVersionDays: finding.noncurrentDays });
      deps.telemetry.captureError(error, FINGERPRINT_CODES.backupRetentionOverdue);
      // One offender proves the finding, so the rest of the listing is a cost
      // with nothing to buy.
      return;
    }
    cursor = listed.value.nextCursor;
    if (cursor === undefined) return;
  }
  // The budget ran out with the listing unfinished. Reported rather than read
  // as clean: everything past the last page drawn is unexamined, and a check
  // that quietly stops looking reports all-clear over exactly the part of the
  // repository it failed to scan — which is the hole this auditor closes.
  // Reported apart from a store that would not answer, because the repair is
  // this auditor's own budget rather than anything about the store.
  deps.telemetry.error('backup retention audit ran out of listing budget', {
    errorCode: FINGERPRINT_CODES.backupRetentionUnscanned,
  });
  deps.telemetry.captureError(
    new Error('backup retention audit ran out of listing budget'),
    FINGERPRINT_CODES.backupRetentionUnscanned
  );
}

export function createBackupRetentionAuditEntry(resolve: () => BackupAuditDeps): CronEntry {
  return {
    name: 'backup-retention-audit',
    // Deps resolve inside the run so a missing binding fails this entry alone
    // (the runner captures it) and never its cadence siblings.
    run: async (): Promise<void> => {
      await auditRetention(resolve());
    },
  };
}
