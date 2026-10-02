import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  judgeLifecycleRules,
  judgeNoncurrentVersions,
  judgeSnapshotFreshness,
  scanVersionPage,
} from '../domain/audit/backup-audit.js';
import { createFakeBackupRepositoryReader } from './backup-repository-fake.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

describe('createFakeBackupRepositoryReader', () => {
  it('dates the newest snapshot at the instant it is asked', async () => {
    const result = await createFakeBackupRepositoryReader(() => NOW).newestSnapshotAt();

    expect(result._unsafeUnwrap()).toEqual(NOW);
  });

  it('answers a repository the freshness judgement finds fresh', async () => {
    const reader = createFakeBackupRepositoryReader(() => NOW);

    const result = await reader.newestSnapshotAt();

    expect(judgeSnapshotFreshness(result._unsafeUnwrap(), NOW)).toEqual({ kind: 'fresh' });
  });

  it('answers a bucket the lifecycle judgement finds correct', async () => {
    const reader = createFakeBackupRepositoryReader(() => NOW);

    const result = await reader.lifecycleRules();

    expect(judgeLifecycleRules(result._unsafeUnwrap(), reader.repositoryPrefix)).toEqual({
      kind: 'correct',
    });
  });

  it('answers a versions listing the retention judgement finds clean', async () => {
    const reader = createFakeBackupRepositoryReader(() => NOW);

    const listed = await reader.listObjectVersions();
    const page = listed._unsafeUnwrap();

    expect(judgeNoncurrentVersions(scanVersionPage(page.versions, {}), NOW)).toEqual({
      kind: 'clean',
    });
  });

  it('answers a versions listing complete in one page, so the audit never exhausts its budget', async () => {
    const reader = createFakeBackupRepositoryReader(() => NOW);

    const listed = await reader.listObjectVersions();

    expect(listed._unsafeUnwrap().nextCursor).toBeUndefined();
  });
});
