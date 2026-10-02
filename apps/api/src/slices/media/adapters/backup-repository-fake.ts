import { okAsync } from '../../../lib/result/index.js';
import { BACKUP_LIFECYCLE_NONCURRENT_DAYS } from '../ports/index.js';
import type {
  BackupLifecycleRule,
  BackupRepositoryReader,
  BackupVersionPage,
} from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The local/CI backup repository: one written this instant, in a bucket
 * carrying the promised retention rule and destroying hidden versions on time.
 * No network, no store, no finding.
 *
 * It exists because the local scheduler fires every deployed schedule at its
 * real cadence while neither the backup workflow nor a B2 account runs outside
 * production — so the real reader would report a finding on every pass until
 * someone had run a backup by hand, and an auditor that always fires is one
 * its readers learn to skip.
 *
 * The whole bucket is the repository here, which is why the prefix is empty
 * and the rule covers everything: this stands for a correctly configured
 * store, not for any particular one.
 */
export function createFakeBackupRepositoryReader(now: () => Date): BackupRepositoryReader {
  const rules: readonly BackupLifecycleRule[] = [
    { prefix: '', noncurrentDays: BACKUP_LIFECYCLE_NONCURRENT_DAYS },
  ];
  return {
    repositoryPrefix: '',
    newestSnapshotAt: (): ResultAsync<Date | null, DomainError> => okAsync(now()),
    lifecycleRules: (): ResultAsync<readonly BackupLifecycleRule[], DomainError> => okAsync(rules),
    // A key holding a current version and one hidden by it a moment ago: the
    // shape a healthy repository has, complete in one page so the audit's page
    // budget is never the thing a local run reports on.
    listObjectVersions: (): ResultAsync<BackupVersionPage, DomainError> =>
      okAsync({
        versions: [
          { key: 'data/pack', lastModified: now() },
          { key: 'data/pack', lastModified: now() },
        ],
      }),
  };
}
