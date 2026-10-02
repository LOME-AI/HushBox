import { BACKUP_LIFECYCLE_NONCURRENT_DAYS } from '../../ports/index.js';
import type { BackupLifecycleRule, BackupObjectVersion } from '../../ports/index.js';

/**
 * The judgements the backup auditor makes, as pure functions over what the
 * repository reader returned. All are read-only detection: repair is a human
 * re-running the backup workflow or fixing the bucket's configuration.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How old the newest snapshot may be before the repository counts as stale.
 * The backup runs hourly, so three hours absorbs one missed run plus the
 * scheduler's own delay without alarming.
 */
export const BACKUP_STALENESS_TOLERANCE_MS = 3 * HOUR_MS;

export type BackupStaleness =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'stale'; readonly ageMinutes: number };

export type BackupLifecycle =
  | { readonly kind: 'correct' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'wrongDuration'; readonly noncurrentDays: number };

/**
 * A repository holding no snapshot is reported apart from a stale one because
 * it has no age to report, not because the repair differs.
 */
export function judgeSnapshotFreshness(newestAt: Date | null, now: Date): BackupStaleness {
  if (newestAt === null) return { kind: 'empty' };
  const ageMs = now.getTime() - newestAt.getTime();
  if (ageMs <= BACKUP_STALENESS_TOLERANCE_MS) return { kind: 'fresh' };
  return { kind: 'stale', ageMinutes: Math.floor(ageMs / MINUTE_MS) };
}

/** A rule covers the repository when its prefix is a prefix of the repository's. */
function covers(rule: BackupLifecycleRule, repositoryPrefix: string): boolean {
  return repositoryPrefix.startsWith(rule.prefix);
}

/**
 * The rule set is judged on the shortest expiry among the covering rules,
 * because that is the one the store applies: overlapping lifecycle rules
 * combine on their smallest values.
 */
export function judgeLifecycleRules(
  rules: readonly BackupLifecycleRule[],
  repositoryPrefix: string
): BackupLifecycle {
  const durations = rules
    .filter((rule) => covers(rule, repositoryPrefix))
    .map((rule) => rule.noncurrentDays)
    .filter((days): days is number => days !== undefined);
  if (durations.length === 0) return { kind: 'absent' };
  const effective = Math.min(...durations);
  if (effective !== BACKUP_LIFECYCLE_NONCURRENT_DAYS) {
    return { kind: 'wrongDuration', noncurrentDays: effective };
  }
  return { kind: 'correct' };
}

/**
 * Days a noncurrent version may outlive the lifecycle window before this audit
 * calls it overdue.
 *
 * The store applies its lifecycle rule on a sweep of its own, whose completion
 * it does not publish as a bound — so a version can legitimately sit a while
 * past the window with nothing wrong. The grace must exceed that cadence or
 * the first slow sweep pages a human for nothing, and it must stay far short
 * of the published ceiling or the audit only bites once the promise is already
 * at risk. A week clears a multi-day stall and still leaves the ceiling most
 * of its headroom.
 */
export const BACKUP_SWEEP_GRACE_DAYS = 7;

/**
 * How many pages of the versions listing one pass may draw.
 *
 * The cost of this check is inverted: a violation stops at the first offender,
 * while a healthy repository is the case that pays for a full listing every
 * run. What the limit bounds is subrequests — one per page, times the retry
 * policy's attempts — against a Worker invocation's allowance, which is what
 * makes a full listing affordable at a daily cadence and not at an hourly
 * one. How many entries that covers is the page size the reader asks the store
 * for (`apps/api/src/slices/media/adapters/backup-repository-s3.ts`).
 *
 * Reaching the limit is reported rather than treated as a clean repository;
 * the entry in `apps/api/src/slices/media/domain/audit/entries.ts` states why.
 */
export const BACKUP_VERSION_PAGE_LIMIT = 50;

/**
 * How a versions listing reads so far: the entry the last page ended on, and
 * the oldest instant at which a version that is STILL PRESENT stopped being
 * current.
 *
 * The listing reports when an entry was uploaded and the expiry window counts
 * from when it stopped being current, which are different instants — a backup
 * pack legitimately stays current for months. The second instant is not in the
 * listing as a field; it is the timestamp of the next-newer entry of the same
 * key, which is why the scan is a fold over the listing's own order rather
 * than a filter over each entry.
 */
export interface BackupVersionScan {
  /** The last entry of the page just read: the next-newer neighbour of whatever follows it. */
  readonly previous?: { readonly key: string; readonly at: Date };
  readonly oldestNoncurrentSince?: Date;
}

export type BackupRetention =
  | { readonly kind: 'clean' }
  | { readonly kind: 'overdue'; readonly noncurrentDays: number };

/**
 * Folds one page of the listing into the scan. Pages are fed in listing order
 * and {@link BackupVersionScan.previous} crosses the boundary between them,
 * because a key's versions can straddle a page and the entry that dates the
 * first version of the new page sits at the end of the old one.
 */
export function scanVersionPage(
  versions: readonly BackupObjectVersion[],
  scan: BackupVersionScan
): BackupVersionScan {
  let previous = scan.previous;
  let oldest = scan.oldestNoncurrentSince;
  for (const version of versions) {
    // Same key as the entry above it means this one is noncurrent, and it
    // became so when that entry landed.
    const hiddenAt = previous?.key === version.key ? previous.at : undefined;
    if (hiddenAt !== undefined && (oldest === undefined || hiddenAt < oldest)) {
      oldest = hiddenAt;
    }
    previous = { key: version.key, at: version.lastModified };
  }
  return {
    ...(previous === undefined ? {} : { previous }),
    ...(oldest === undefined ? {} : { oldestNoncurrentSince: oldest }),
  };
}

/**
 * Whether anything the scan saw has outlived the window the lifecycle rule
 * promises. A version still present that far past its hiding is the observable
 * effect of the rule not erasing — a retention lock, a rule that silently
 * stopped applying, or a stalled vendor sweep all present this way, and none
 * of them is visible in the rule's own configuration.
 */
export function judgeNoncurrentVersions(scan: BackupVersionScan, now: Date): BackupRetention {
  const since = scan.oldestNoncurrentSince;
  if (since === undefined) return { kind: 'clean' };
  const noncurrentMs = now.getTime() - since.getTime();
  const windowMs = (BACKUP_LIFECYCLE_NONCURRENT_DAYS + BACKUP_SWEEP_GRACE_DAYS) * DAY_MS;
  if (noncurrentMs <= windowMs) return { kind: 'clean' };
  // How long it has been noncurrent, not how far past the window: the window
  // is a constant a reader can look up, and the absolute age keeps its meaning
  // if the grace ever moves.
  return { kind: 'overdue', noncurrentDays: Math.floor(noncurrentMs / DAY_MS) };
}
