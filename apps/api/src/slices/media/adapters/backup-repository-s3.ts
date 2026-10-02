import { AwsClient } from 'aws4fetch';
import { createEnvUtilities } from '@hushbox/shared';
import { retryWithTimeoutPolicy } from '../../../lib/resilience/index.js';
import { backupRepositoryPrefix, backupSnapshotsPrefix } from '../ports/index.js';
import { parseListObjectsV2Response } from './list-xml.js';
import { parseLifecycleConfigurationResponse } from './backup-lifecycle-xml.js';
import { parseListObjectVersionsResponse } from './backup-versions-xml.js';
import { extractTag } from './s3-xml.js';
import { createFakeBackupRepositoryReader } from './backup-repository-fake.js';
import type { EnvContext } from '@hushbox/shared';
import type {
  BackupLifecycleRule,
  BackupRepositoryReader,
  BackupVersionCursor,
  BackupVersionPage,
} from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The read-only S3 view of the backup repository, over the same aws4fetch
 * codepath the media adapter uses: MinIO locally, Backblaze B2 in production.
 * The credential behind it lists and holds nothing else — no object body, no
 * write, no delete — so neither a bug here nor a stolen key can damage a
 * backup or read one.
 *
 * Object versions are read through the S3 form (`GET /<bucket>?versions`),
 * which needs only the list capability this credential already holds — unlike
 * the bucket's retention-lock configuration, which cannot be read without a
 * capability the credential deliberately does not carry. What the versions
 * listing shows is the lifecycle rule's EFFECT rather than its statement, which
 * is the thing the published ceiling actually rests on.
 *
 * Bucket lifecycle rules are read through the S3 form
 * (`GET /<bucket>?lifecycle`), which B2 answers from its own native rules —
 * `NoncurrentVersionExpiration.NoncurrentDays` is how it states the
 * `daysFromHidingToDeleting` the retention promise rests on. A bucket carrying
 * no configuration answers 404 with `NoSuchLifecycleConfiguration`, which is a
 * legitimate empty answer and not a failure; every other 404 (a bucket that is
 * not there) is a failure, because a missing bucket read as "no rules" would
 * name the wrong repair.
 */

const AUDIT_NETWORK = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  timeoutMs: 15_000,
} as const;

const LIST_PAGE_LIMIT = 1000;

/** The B2 error code for a bucket that simply carries no lifecycle rules. */
const NO_LIFECYCLE_CODE = 'NoSuchLifecycleConfiguration';

export interface BackupRepositoryConfig {
  readonly endpoint: string;
  /** The signing region; a B2 key is minted per region and the signature is scoped to it. */
  readonly region: string;
  readonly bucket: string;
  /** Key prefix the repository occupies inside the bucket; empty is the whole bucket. */
  readonly repositoryRoot: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The bindings the reader is built from (same names the backup workflow reads). */
export interface BackupRepositoryEnv extends EnvContext {
  BACKUP_B2_S3_ENDPOINT?: string;
  BACKUP_B2_REGION?: string;
  BACKUP_B2_BUCKET?: string;
  BACKUP_REPO_ROOT?: string;
  BACKUP_B2_AUDITOR_KEY_ID?: string;
  BACKUP_B2_AUDITOR_KEY?: string;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`backup repository config: ${field} is required`);
  }
}

function requireBinding(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required to audit the backup repository — the auditor fails fast instead of reporting all-clear`
    );
  }
  return value;
}

export function createBackupRepositoryReader(
  config: BackupRepositoryConfig
): BackupRepositoryReader {
  requireNonEmpty(config.endpoint, 'endpoint');
  requireNonEmpty(config.region, 'region');
  requireNonEmpty(config.bucket, 'bucket');
  requireNonEmpty(config.accessKeyId, 'accessKeyId');
  requireNonEmpty(config.secretAccessKey, 'secretAccessKey');

  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
    // The policy factory is the single retry seam; aws4fetch's own retries
    // would be a second one hidden inside every attempt.
    retries: 0,
  });
  const runner = retryWithTimeoutPolicy(AUDIT_NETWORK);
  const bucketUrl = `${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}`;
  const snapshotsPrefix = backupSnapshotsPrefix(config.repositoryRoot);
  const repositoryPrefix = backupRepositoryPrefix(config.repositoryRoot);

  const listUrl = (cursor: string | undefined): string => {
    const params = new URLSearchParams({
      'list-type': '2',
      prefix: snapshotsPrefix,
      'max-keys': String(LIST_PAGE_LIMIT),
    });
    if (cursor !== undefined) {
      params.set('continuation-token', cursor);
    }
    return `${bucketUrl}?${params.toString()}`;
  };

  const versionsUrl = (cursor: BackupVersionCursor | undefined): string => {
    const params = new URLSearchParams({
      prefix: repositoryPrefix,
      'max-keys': String(LIST_PAGE_LIMIT),
    });
    if (cursor !== undefined) {
      params.set('key-marker', cursor.keyMarker);
      // Both markers or the store resumes at the NEXT key, skipping the rest of
      // a key whose versions the page boundary split — the range an overdue
      // version is most likely to be sitting in.
      if (cursor.versionIdMarker !== undefined) {
        params.set('version-id-marker', cursor.versionIdMarker);
      }
    }
    return `${bucketUrl}?versions&${params.toString()}`;
  };

  return {
    repositoryPrefix,

    newestSnapshotAt(): ResultAsync<Date | null, DomainError> {
      return runner.run(async (signal) => {
        let cursor: string | undefined;
        let newest: Date | null = null;
        do {
          const response = await aws.fetch(listUrl(cursor), { method: 'GET', signal });
          if (!response.ok) {
            // The status and nothing else: a store's error body is text we did
            // not write, bound for a channel that carries codes only.
            throw new Error(`backup snapshot listing returned ${String(response.status)}`);
          }
          const page = parseListObjectsV2Response(await response.text());
          for (const object of page.objects) {
            if (newest === null || object.uploaded > newest) newest = object.uploaded;
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return newest;
      });
    },

    lifecycleRules(): ResultAsync<readonly BackupLifecycleRule[], DomainError> {
      return runner.run(async (signal) => {
        const response = await aws.fetch(`${bucketUrl}?lifecycle`, { method: 'GET', signal });
        const body = await response.text();
        if (response.status === 404 && extractTag(body, 'Code') === NO_LIFECYCLE_CODE) {
          return [];
        }
        if (!response.ok) {
          throw new Error(`backup lifecycle read returned ${String(response.status)}`);
        }
        return parseLifecycleConfigurationResponse(body);
      });
    },

    listObjectVersions(cursor?: BackupVersionCursor): ResultAsync<BackupVersionPage, DomainError> {
      // One page per call, so the retry policy re-draws the failed page rather
      // than the whole listing, and the caller keeps the page budget: how many
      // pages a pass may draw is a judgement about the auditor's cost, not
      // about how to talk to the store.
      return runner.run(async (signal) => {
        const response = await aws.fetch(versionsUrl(cursor), { method: 'GET', signal });
        if (!response.ok) {
          throw new Error(`backup version listing returned ${String(response.status)}`);
        }
        return parseListObjectVersionsResponse(await response.text());
      });
    },
  };
}

/**
 * Reader selection: the fake (a fresh repository, the promised rule, no
 * network) everywhere the real store is not exercisable — local dev, CI, E2E.
 * Production binds the real reader and fails fast and loud on a missing
 * binding VALUE — never a fake fallback: a production auditor answering from
 * canned data would report all-clear over a backup that had stopped.
 *
 * `now` dates the fake's snapshot; the real reader takes its instants from the
 * store.
 */
export function createBackupRepositoryReaderFromEnv(
  env: BackupRepositoryEnv,
  now: () => Date
): BackupRepositoryReader {
  const { isProduction } = createEnvUtilities(env);
  if (!isProduction) {
    return createFakeBackupRepositoryReader(now);
  }
  return createBackupRepositoryReader({
    endpoint: requireBinding(env.BACKUP_B2_S3_ENDPOINT, 'BACKUP_B2_S3_ENDPOINT'),
    region: requireBinding(env.BACKUP_B2_REGION, 'BACKUP_B2_REGION'),
    bucket: requireBinding(env.BACKUP_B2_BUCKET, 'BACKUP_B2_BUCKET'),
    repositoryRoot: requireBinding(env.BACKUP_REPO_ROOT, 'BACKUP_REPO_ROOT'),
    accessKeyId: requireBinding(env.BACKUP_B2_AUDITOR_KEY_ID, 'BACKUP_B2_AUDITOR_KEY_ID'),
    secretAccessKey: requireBinding(env.BACKUP_B2_AUDITOR_KEY, 'BACKUP_B2_AUDITOR_KEY'),
  });
}
