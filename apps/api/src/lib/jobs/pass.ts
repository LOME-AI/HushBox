import { sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import { backoffSeconds } from './backoff.js';
import {
  batchSizeForShard,
  claimBatch,
  deadLetterExhausted,
  sweepCancelRequested,
} from './claim.js';
import { completeDead, completeFail, completeOk, completeYield } from './complete.js';
import { LEASE_TIMEOUT_ERROR } from './lease-timeout.js';
import { jobOutcome } from './outcome.js';
import { RECLAIM_MARGIN_SECONDS } from './registry.js';
import { FINGERPRINT_CODES } from '../telemetry/index.js';
import type { Database } from '@hushbox/db';
import type { JobPassExecutor, JobPassResult } from '@hushbox/realtime';
import type { DbWriter } from '../idempotency/transaction.js';
import type { Telemetry } from '../telemetry/index.js';
import type { ExecutionBudget } from './chunked.js';
import type { JobFence } from './complete.js';
import type { JobOutcome } from './outcome.js';
import type { JobExecution, JobRegistry, JobRow, JobRun, JobShard } from './registry.js';

/**
 * The dispatcher's executor core: one pass = sweep cancels, dead-letter
 * exhausted rows, claim a batch, execute against each job's execution budget,
 * complete through the fence — then advise the next alarm. Plain module by
 * design (thin-shell doctrine); the JobDispatcher DO calls this through
 * `@hushbox/realtime`'s core.
 */

/** Floor on the re-arm delay; sub-floor advice would busy-spin the alarm. */
export const MIN_REARM_DELAY_MS = 250;

interface JobExecutorDeps {
  /**
   * Scopes a fresh Database to one pass (fresh Neon connection per
   * invocation; the production binding closes the pool afterwards).
   */
  withDb<T>(use: (db: Database) => Promise<T>): Promise<T>;
  readonly registry: JobRegistry;
  readonly telemetry: Telemetry;
  /** Completion-fence identity; unique per dispatcher instance. */
  readonly claimantId: string;
  /** Jitter source for retry backoff — injected so tests can seed it. */
  readonly random: () => number;
  readonly now: () => number;
  /**
   * Wall budget for drain chaining: when claims keep returning full batches
   * past this, the pass yields and advises an immediate re-fire instead of
   * running into the platform's alarm wall cap.
   */
  readonly passBudgetMs: number;
}

/**
 * Converts the Postgres-computed re-arm interval (epoch seconds of
 * `min(next attempt) - now()`) to milliseconds. The interval arrives from
 * the database clock, never from comparing PG timestamps to the DO clock.
 */
export function rearmDelayMs(epochSeconds?: string | number | null): number | undefined {
  if (epochSeconds === null || epochSeconds === undefined) return undefined;
  const seconds = typeof epochSeconds === 'number' ? epochSeconds : Number(epochSeconds);
  if (Number.isNaN(seconds)) {
    throw new TypeError(
      `jobs pass: non-numeric re-arm delay from Postgres: ${String(epochSeconds)}`
    );
  }
  return Math.max(MIN_REARM_DELAY_MS, Math.ceil(seconds * 1000));
}

function parseShard(shard: string): JobShard {
  if (shard === 'default' || shard === 'bulk') return shard;
  throw new Error(
    `jobs pass: unknown shard ${JSON.stringify(shard)} — dispatcher DOs are named default|bulk`
  );
}

async function invokeWork(
  run: JobRun,
  execution: JobExecution<unknown>,
  budget: ExecutionBudget
): Promise<JobOutcome> {
  try {
    return await run(execution, budget);
    // eslint-disable-next-line catch-swallow/no-silent-catch -- handler throw becomes jobOutcome.fail; the dispatcher warns, persists the error, retries, and dead-letters — no loss.
  } catch (error) {
    return jobOutcome.fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Races the handler against its execution budget, so a hung handler cannot eat
 * the pass. The budget sits a reclaim margin inside the row's lease, so the
 * kill and its terminal write both land while this claimant still holds the
 * row. The loser is abandoned, not killed: any late write it attempts goes
 * through the completion fence and loses there.
 */
async function raceExecutionBudget(
  invocation: Promise<JobOutcome>,
  budgetMs: number
): Promise<JobOutcome | 'budget-timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'budget-timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('budget-timeout');
    }, budgetMs);
  });
  try {
    return await Promise.race([invocation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextScheduledDelayMs(db: Database, shard: JobShard): Promise<number | undefined> {
  // Schedulable work = pending rows at their nextAttemptAt and running rows
  // at their lease expiry (a crashed claimant's row becomes claimable then).
  const result = await db.execute(sql`
    SELECT extract(epoch FROM least(
      min(${jobs.nextAttemptAt}) FILTER (WHERE ${jobs.status} = 'pending' AND NOT ${jobs.cancelRequested}),
      min(${jobs.claimedAt} + make_interval(secs => ${jobs.leaseSeconds})) FILTER (WHERE ${jobs.status} = 'running')
    ) - now()) AS delay_seconds
    FROM ${jobs}
    WHERE ${jobs.shard} = ${shard} AND ${jobs.status} IN ('pending', 'running')
  `);
  const row = result.rows[0] as { delay_seconds: string | number | null } | undefined;
  return rearmDelayMs(row?.delay_seconds);
}

/**
 * Every way a row retires to `dead`, with the content-free message its alert
 * carries. A broken handler dead-letters a whole batch at once, so the capture
 * fires once per condition per pass; the console line beside it is what names
 * which rows died.
 */
const DEAD_LETTER_ALERTS = {
  atClaim: 'job dead-lettered at claim',
  unregisteredType: 'job dead-lettered: unregistered type',
  unparseablePayload: 'job dead-lettered: unparseable payload',
  byHandler: 'job dead-lettered by its handler',
} as const;

type DeadLetterCondition = keyof typeof DEAD_LETTER_ALERTS;

interface DeadLetterAlerts {
  /** Marks a condition seen; the per-job console line is written separately. */
  record: (condition: DeadLetterCondition) => void;
  /** Raises one capture per distinct condition seen, then forgets them. */
  flush: () => void;
}

function createDeadLetterAlerts(telemetry: Telemetry): DeadLetterAlerts {
  const seen = new Set<DeadLetterCondition>();
  return {
    record: (condition): void => {
      seen.add(condition);
    },
    flush: (): void => {
      for (const condition of seen) {
        telemetry.captureError(
          new Error(DEAD_LETTER_ALERTS[condition]),
          FINGERPRINT_CODES.jobDeadLetter
        );
      }
      seen.clear();
    },
  };
}

export function createJobExecutor(deps: JobExecutorDeps): JobPassExecutor {
  const { registry, telemetry, claimantId, random, now, passBudgetMs } = deps;

  function fenceFor(job: JobRow): JobFence {
    return { jobId: job.id, claimedBy: claimantId, claims: job.claims };
  }

  async function executeOne(db: Database, job: JobRow, alerts: DeadLetterAlerts): Promise<void> {
    const fence = fenceFor(job);
    const registration = registry.get(job.type);
    if (registration === undefined) {
      await completeDead(db, fence, 'unregistered job type');
      telemetry.error('job dead-lettered: unregistered type', {
        jobId: job.id,
        jobType: job.type,
      });
      alerts.record('unregisteredType');
      return;
    }
    const parsed = registration.schema.safeParse(job.payload);
    if (!parsed.success) {
      await completeDead(db, fence, 'payload failed its registered schema');
      telemetry.error('job dead-lettered: unparseable payload', {
        jobId: job.id,
        jobType: job.type,
      });
      alerts.record('unparseablePayload');
      return;
    }
    const execution = {
      jobId: job.id,
      payload: parsed.data,
      claims: job.claims,
      completeWithinTx: async (writer: DbWriter, result: unknown = null): Promise<JobOutcome> => {
        const written = await completeOk(writer, fence, result);
        if (written === 'lost') {
          // Thrown, not returned: aborting the handler's transaction is what
          // keeps a zombie's effect from committing without its transition.
          throw new Error('job completion lost the fence: this claimant is a zombie');
        }
        return { kind: 'completed', completion: written };
      },
    };
    // Floored against the row rather than trusting the registration alone: a
    // row's lease was stamped by the registration in force when it was
    // enqueued, and a later deploy can raise the budget past it. The smaller
    // value is what keeps the kill strictly inside the lease this row carries.
    const budgetSeconds = Math.min(
      registration.maxExecutionSeconds,
      job.leaseSeconds - RECLAIM_MARGIN_SECONDS
    );
    const budgetMs = budgetSeconds * 1000;
    const raced = await raceExecutionBudget(
      invokeWork(registration.run, execution, { totalMs: budgetMs, now }),
      budgetMs
    );
    const outcome = raced === 'budget-timeout' ? jobOutcome.fail(LEASE_TIMEOUT_ERROR) : raced;
    // A txn-class handler already wrote the fenced terminal transition in its
    // own transaction; a second write here would miss the consumed fence and
    // pollute the genuine zombie signal below.
    if (outcome.kind === 'completed') return;
    const completion = await completeForOutcome(db, job, outcome, alerts);
    if (completion === 'lost') {
      telemetry.warn('job completion lost the fence', { jobId: job.id, jobType: job.type });
    }
  }

  async function executeOneObserved(
    db: Database,
    job: JobRow,
    alerts: DeadLetterAlerts
  ): Promise<void> {
    try {
      await executeOne(db, job, alerts);
    } catch (error) {
      // executeOne rejects only when a completion write fails; the row's
      // lease already makes it reclaimable, so telemetry is the entire
      // response — a retry here would be a second delivery mechanism.
      telemetry.error('job completion write failed', { jobId: job.id, jobType: job.type });
      telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        FINGERPRINT_CODES.jobCompletionWriteFailed
      );
    }
  }

  /** Retires the shard's exhausted rows, naming each on its own console line. */
  async function sweepDeadLettered(
    db: Database,
    shard: JobShard,
    alerts: DeadLetterAlerts
  ): Promise<void> {
    const deadLettered = await deadLetterExhausted(db, shard);
    for (const dead of deadLettered) {
      telemetry.error('job dead-lettered at claim', { jobId: dead.id, jobType: dead.type });
      alerts.record('atClaim');
    }
  }

  async function completeForOutcome(
    db: Database,
    job: JobRow,
    outcome: Exclude<JobOutcome, { kind: 'completed' }>,
    alerts: DeadLetterAlerts
  ): Promise<string> {
    const fence = fenceFor(job);
    switch (outcome.kind) {
      case 'ok': {
        return completeOk(db, fence, outcome.result);
      }
      case 'fail': {
        telemetry.warn('job handler failed', {
          jobId: job.id,
          jobType: job.type,
          attempt: job.claims,
        });
        return completeFail(db, fence, {
          error: outcome.error,
          backoffSeconds: backoffSeconds(job.failures + 1, random),
        });
      }
      case 'yield': {
        return completeYield(db, fence, outcome.checkpoint);
      }
      case 'dead': {
        telemetry.error('job dead-lettered by its handler', {
          jobId: job.id,
          jobType: job.type,
        });
        alerts.record('byHandler');
        return completeDead(db, fence, outcome.error);
      }
    }
  }

  return {
    // async so a mis-named shard rejects (the DO awaits) instead of throwing
    // through the alarm handler synchronously.
    async runPass(shardName: string): Promise<JobPassResult> {
      const shard = parseShard(shardName);
      return deps.withDb(async (db): Promise<JobPassResult> => {
        const startedAt = now();
        // Pass-scoped so a chained drain alerts once per condition rather than
        // once per batch; flushed in `finally` so a pass that rejects mid-drain
        // still reports what it retired.
        const alerts = createDeadLetterAlerts(telemetry);
        let budgetExhausted = false;
        try {
          // Drain chaining: claim another batch immediately while due work
          // remains, bounded by the pass budget.
          for (;;) {
            await sweepCancelRequested(db, shard);
            await sweepDeadLettered(db, shard, alerts);
            const batch = await claimBatch(db, {
              shard,
              claimantId,
              limit: batchSizeForShard(shard),
            });
            if (batch.length === 0) break;
            await Promise.all(batch.map((job) => executeOneObserved(db, job, alerts)));
            if (now() - startedAt >= passBudgetMs) {
              budgetExhausted = true;
              break;
            }
          }
          if (budgetExhausted) return { kind: 'due' };
          const delayMs = await nextScheduledDelayMs(db, shard);
          return delayMs === undefined ? { kind: 'idle' } : { kind: 'scheduled', delayMs };
        } finally {
          alerts.flush();
        }
      });
    },
  };
}
