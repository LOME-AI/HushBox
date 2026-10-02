import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * What the backup-repository auditor reads. The repository is written by the
 * hourly backup workflow and never by this Worker, so the port carries reads
 * only — there is nothing here a bug could use to damage a backup.
 */

/**
 * One lifecycle rule as the object store states it, reduced to the two fields
 * the audit reads.
 */
export interface BackupLifecycleRule {
  /** The key prefix the rule applies to; an empty string covers the bucket. */
  readonly prefix: string;
  /**
   * Days a noncurrent version survives before the store destroys it — S3's
   * `NoncurrentVersionExpiration.NoncurrentDays`, which Backblaze B2 holds as
   * its own `daysFromHidingToDeleting`. Absent on a rule declaring no such
   * action, which is a rule that destroys nothing.
   */
  readonly noncurrentDays?: number;
}

/**
 * Re-exported rather than declared: the number is a term of the published
 * retention ceiling, and the arithmetic that adds it up lives in the backup
 * orchestrator under `scripts/`, which cannot import from this app. One
 * declaration in `@hushbox/shared` is what keeps the audited value and the
 * computed ceiling from drifting apart.
 */
export { BACKUP_LIFECYCLE_NONCURRENT_DAYS } from '@hushbox/shared';

/**
 * One entry of an object-versions listing. A delete marker is one of these
 * too: the store reports it in the same sequence, and the audit reads it for
 * the same reason it reads a version — as the neighbour that dates whatever
 * sits under it.
 *
 * There is deliberately no "is current" flag. The listing groups entries by
 * key, newest first, and that ordering is what says which entry is current;
 * a flag would say so a second time without supplying the one fact the audit
 * needs, which is the instant a version stopped being current.
 */
export interface BackupObjectVersion {
  readonly key: string;
  /** When the store took this entry, which is when the entry below it stopped being current. */
  readonly lastModified: Date;
}

/**
 * Where a truncated versions listing resumes. Both markers travel because a
 * page can end in the middle of a key's versions: the key marker alone would
 * resume at the NEXT key and skip the rest of that key's versions, which is
 * exactly the range an overdue version hides in.
 */
export interface BackupVersionCursor {
  readonly keyMarker: string;
  readonly versionIdMarker?: string;
}

export interface BackupVersionPage {
  /** Listing order as the store returned it: grouped by key, newest entry of each key first. */
  readonly versions: readonly BackupObjectVersion[];
  /** Absent when this page is the end of the listing. */
  readonly nextCursor?: BackupVersionCursor;
}

export interface BackupRepositoryReader {
  /**
   * The key prefix this reader is a view of, closed with a separator. The
   * lifecycle judgement asks which rules cover it, so the prefix the audit
   * judges against is the one the reader actually listed under.
   */
  readonly repositoryPrefix: string;
  /**
   * The newest `LastModified` across the repository's snapshot objects, or
   * `null` when the repository holds none. A restic-format repository writes
   * one object per snapshot, last in a run, so that instant is the run's
   * completion time.
   */
  newestSnapshotAt(): ResultAsync<Date | null, DomainError>;
  /** Every lifecycle rule the backup bucket carries; empty when it carries none. */
  lifecycleRules(): ResultAsync<readonly BackupLifecycleRule[], DomainError>;
  /**
   * One page of the repository's object versions, from the start of the
   * listing when given no cursor. Listing versions is what the retention audit
   * reads instead of the bucket's retention-lock configuration, which needs a
   * capability this reader's credential deliberately does not hold: the
   * listing shows whether versions are actually being destroyed, which is the
   * thing the published ceiling is about.
   */
  listObjectVersions(cursor?: BackupVersionCursor): ResultAsync<BackupVersionPage, DomainError>;
}

/**
 * The repository's key prefix, as the object store matches prefixes: closed
 * with a separator so it cannot match a sibling root whose name merely starts
 * with the same characters, and empty when the repository occupies the whole
 * bucket. Shared by the reader that lists under it and by the lifecycle
 * judgement that asks which rules cover it, so the two cannot disagree about
 * what the repository's prefix is.
 */
export function backupRepositoryPrefix(root: string): string {
  const trimmed = root.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** Where a restic-format repository keeps one object per snapshot. */
export function backupSnapshotsPrefix(root: string): string {
  return `${backupRepositoryPrefix(root)}snapshots/`;
}
