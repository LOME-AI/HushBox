import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import { LEASE_TIMEOUT_ERROR_PREFIX } from './lease-timeout.js';
import { RECORDED_ERROR_KEYS } from './recorded-error.js';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobShard } from './registry.js';

/**
 * Read-only probes for the auditors on the 15-minute cron. An auditor detects
 * and pages; the one mutation any of them triggers is the blessed `wake()`
 * clock-nudge, which lives with the caller — nothing here writes. Every probe
 * stays inside the claim partial index's predicate
 * (`status IN ('pending','running')`), so scans never touch terminal rows.
 */

/** A due pending row unclaimed this long past `nextAttemptAt` is stuck. */
export const STUCK_PENDING_GRACE_SECONDS = 600;

/** A running row is stuck once it has held its lease this many times over. */
export const STUCK_RUNNING_LEASE_MULTIPLIER = 2;

/**
 * How far back one sweep looks. Several cadences wide, so a tick that is late
 * or skipped still reports the kill, and a type that keeps hitting the wall
 * keeps paging until it is repaired; bounded, so a repaired type stops paging
 * on its own with no state for anyone to clear.
 */
export const LEASE_TIMEOUT_WINDOW_SECONDS = 3600;

export interface StuckJobRow {
  readonly id: string;
  readonly type: string;
  readonly shard: JobShard;
  readonly status: 'pending' | 'running';
}

interface FindStuckJobsParams {
  readonly limit: number;
}

/**
 * Stuck = the dispatcher should have acted and has not: a claimable pending
 * row (the claim path's own eligibility — not cancel-requested, claim budget
 * left) due past the grace window, or a running row past twice its lease
 * (one lease expiry is normal crash recovery; two means no dispatcher pass
 * reclaimed it). All clock math runs on the database clock.
 */
export async function findStuckJobs(
  writer: DbWriter,
  params: FindStuckJobsParams
): Promise<StuckJobRow[]> {
  const rows = await writer
    .select({ id: jobs.id, type: jobs.type, shard: jobs.shard, status: jobs.status })
    .from(jobs)
    .where(
      or(
        and(
          eq(jobs.status, 'pending'),
          eq(jobs.cancelRequested, false),
          sql`${jobs.claims} < ${jobs.maxClaims}`,
          sql`${jobs.nextAttemptAt} < now() - make_interval(secs => ${STUCK_PENDING_GRACE_SECONDS})`
        ),
        and(
          eq(jobs.status, 'running'),
          sql`${jobs.claimedAt} + make_interval(secs => ${jobs.leaseSeconds} * ${STUCK_RUNNING_LEASE_MULTIPLIER}) < now()`
        )
      )
    )
    .orderBy(asc(jobs.nextAttemptAt), asc(jobs.id))
    .limit(params.limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    shard: row.shard,
    status: row.status === 'running' ? 'running' : 'pending',
  }));
}

interface FindLeaseTimeoutsParams {
  readonly windowSeconds: number;
}

/**
 * The job types that recorded an execution-budget kill inside the window.
 * Grouped by type rather than listed by row because the repair is per type:
 * a handler that outruns its budget does it on every row of that type, and
 * the rows themselves are read out of the database this reading points at.
 */
export async function findLeaseTimeoutTypes(
  writer: DbWriter,
  params: FindLeaseTimeoutsParams
): Promise<string[]> {
  const rows = await writer
    .select({ type: jobs.type })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ['pending', 'running']),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(${jobs.errors}) AS recorded
          WHERE recorded->>${RECORDED_ERROR_KEYS.error}::text LIKE ${`${LEASE_TIMEOUT_ERROR_PREFIX}%`}
            AND (recorded->>${RECORDED_ERROR_KEYS.at}::text)::timestamptz > now() - make_interval(secs => ${params.windowSeconds})
        )`
      )
    )
    .groupBy(jobs.type)
    .orderBy(asc(jobs.type));
  return rows.map((row) => row.type);
}
