import { and, eq, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import { appendRecordedError } from './recorded-error.js';
import type { SQL } from 'drizzle-orm';
import type { DbWriter } from '../idempotency/transaction.js';

/**
 * The completion-fence identity every finishing write must present: the row
 * must still be `running`, held by this claimant, at this claim count. A
 * zombie claimant (lease expired, row re-claimed) matches zero rows — it can
 * neither finish nor checkpoint. Writers accept an open transaction so a
 * `txn`-class handler can commit its effect and the terminal transition
 * atomically.
 */
export interface JobFence {
  readonly jobId: string;
  readonly claimedBy: string;
  readonly claims: number;
}

type JobOkCompletion = 'succeeded' | 'cancelled' | 'lost';
type JobRepenedCompletion = 'repended' | 'cancelled' | 'lost';
type JobDeadCompletion = 'dead' | 'cancelled' | 'lost';

interface JobFailParams {
  readonly error: string;
  readonly backoffSeconds: number;
}

/**
 * Storage cap (characters) for one entry in a job's error history. Error
 * strings are operator diagnostics — codes and summaries per the handler
 * contract, never user content — but a throw stringified from an external
 * call can drag an arbitrary body along; the cap keeps a retry loop from
 * bloating the row, while `errors` keeps one capped entry per attempt.
 */
const JOB_ERROR_MESSAGE_CAP = 4096;

function fenceCondition(fence: JobFence): SQL | undefined {
  return and(
    eq(jobs.id, fence.jobId),
    eq(jobs.status, 'running'),
    eq(jobs.claimedBy, fence.claimedBy),
    eq(jobs.claims, fence.claims)
  );
}

/** `cancelRequested` at the fence wins over any other terminal state. */
function statusUnlessCancelled(status: 'succeeded' | 'pending' | 'dead'): SQL {
  // status is one of three compile-time literals — safe inside sql.raw.
  const fallback = sql.raw(`'${status}'::job_status`);
  return sql`CASE WHEN ${jobs.cancelRequested} THEN 'cancelled'::job_status ELSE ${fallback} END`;
}

function appendedErrors(fence: JobFence, error: string): SQL {
  return appendRecordedError(fence.claims, error.slice(0, JOB_ERROR_MESSAGE_CAP));
}

function fenceWriteResult(rows: { status: string }[]): 'applied' | 'cancelled' | 'lost' {
  const row = rows[0];
  if (row === undefined) return 'lost';
  return row.status === 'cancelled' ? 'cancelled' : 'applied';
}

export async function completeOk(
  writer: DbWriter,
  fence: JobFence,
  result: unknown
): Promise<JobOkCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('succeeded'),
      result,
      finishedAt: sql`now()`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'succeeded' : written;
}

/**
 * Failure re-pends at the caller-computed backoff; the row keeps its full
 * `{at, claim, error}` history. The claim identity is cleared so the pending
 * row carries no stale lease.
 */
export async function completeFail(
  writer: DbWriter,
  fence: JobFence,
  params: JobFailParams
): Promise<JobRepenedCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('pending'),
      failures: sql`${jobs.failures} + 1`,
      nextAttemptAt: sql`now() + make_interval(secs => ${params.backoffSeconds}::double precision)`,
      errors: appendedErrors(fence, params.error),
      claimedAt: null,
      claimedBy: null,
      finishedAt: sql`CASE WHEN ${jobs.cancelRequested} THEN now() ELSE NULL END`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'repended' : written;
}

/**
 * Checkpoint: re-pend immediately with the updated payload and neutralize
 * this execution's claim increment — yields never consume retries. The write
 * passes the same fence as terminal writes, and `cancelRequested` is honored
 * here, so a cancel lands at the next checkpoint boundary.
 */
export async function completeYield(
  writer: DbWriter,
  fence: JobFence,
  checkpoint: unknown
): Promise<JobRepenedCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('pending'),
      payload: checkpoint,
      claims: sql`${jobs.claims} - 1`,
      nextAttemptAt: sql`now()`,
      claimedAt: null,
      claimedBy: null,
      finishedAt: sql`CASE WHEN ${jobs.cancelRequested} THEN now() ELSE NULL END`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'repended' : written;
}

export async function completeDead(
  writer: DbWriter,
  fence: JobFence,
  error: string
): Promise<JobDeadCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('dead'),
      errors: appendedErrors(fence, error),
      finishedAt: sql`now()`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'dead' : written;
}
