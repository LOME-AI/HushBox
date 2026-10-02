import { LEASE_TIMEOUT_WINDOW_SECONDS, findLeaseTimeoutTypes, findStuckJobs } from './health.js';
import { wakeJobDispatcher } from './wake.js';
import { FINGERPRINT_CODES } from '../telemetry/index.js';
import type { StuckJobRow } from './health.js';
import type { JobShard } from './registry.js';
import type { JobDispatcherNamespace } from './wake.js';
import type { DbWriter } from '../idempotency/transaction.js';
import type { Telemetry } from '../telemetry/index.js';
import type { CronEntry } from './cron.js';

/**
 * The jobs-health auditor (15-minute cadence): read-only detection plus the
 * one blessed clock-nudge — `wake()` on both dispatcher shards when stuck
 * work is found, because the platform's at-least-once alarm has a documented
 * wedge failure the perpetual re-arm cannot survive alone.
 */

/** Page cap on the stuck-row scan; one stuck row already pages. */
export const STUCK_JOBS_PAGE_LIMIT = 50;

interface JobsHealthProbes {
  readonly findStuck: () => Promise<StuckJobRow[]>;
}

export function createJobsHealthProbes(db: DbWriter): JobsHealthProbes {
  return {
    findStuck: () => findStuckJobs(db, { limit: STUCK_JOBS_PAGE_LIMIT }),
  };
}

/** The structural env slice the wake nudge needs (absent in local dev/tests). */
interface JobsHealthCronEnv {
  readonly JOB_DISPATCHER?: JobDispatcherNamespace;
}

/**
 * Binds the lossy wake nudge to the DO namespace. An absent binding is a
 * no-op: the dispatcher's perpetual alarm remains the delivery guarantee,
 * and the auditor's page (not the nudge) is the signal a human acts on.
 */
export function createDispatcherWake(env: JobsHealthCronEnv): (shard: JobShard) => Promise<void> {
  return async (shard: JobShard): Promise<void> => {
    const namespace = env.JOB_DISPATCHER;
    if (namespace === undefined) return;
    await wakeJobDispatcher(namespace, shard);
  };
}

interface JobsHealthEntryDeps {
  readonly probes: JobsHealthProbes;
  readonly telemetry: Telemetry;
  readonly wake: (shard: JobShard) => Promise<void>;
}

export function createJobsHealthEntry(deps: JobsHealthEntryDeps): CronEntry {
  return {
    name: 'jobs-health-audit',
    run: async (): Promise<void> => {
      const stuck = await deps.probes.findStuck();
      if (stuck.length === 0) return;
      for (const row of stuck) {
        deps.telemetry.error('job stuck past its health bound', {
          jobId: row.id,
          jobType: row.type,
          errorCode: 'jobs_stuck',
        });
      }
      deps.telemetry.captureError(
        new Error('jobs stuck past health bounds'),
        FINGERPRINT_CODES.jobsStuck
      );
      await deps.wake('default');
      await deps.wake('bulk');
    },
  };
}

interface LeaseTimeoutProbes {
  readonly findLeaseTimeouts: () => Promise<string[]>;
}

export function createLeaseTimeoutProbes(db: DbWriter): LeaseTimeoutProbes {
  return {
    findLeaseTimeouts: () =>
      findLeaseTimeoutTypes(db, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS }),
  };
}

interface LeaseTimeoutEntryDeps {
  readonly probes: LeaseTimeoutProbes;
  readonly telemetry: Telemetry;
}

/**
 * The execution-budget auditor, on the same cadence and read-only throughout —
 * it nudges nothing, because the row's own retry already redelivers the work
 * and what a kill needs from a human is a diagnosis.
 *
 * Two causes reach this page and it cannot tell them apart: the budget is a
 * declaration that the work fits inside it, so a kill says either that
 * declaration is wrong for the work — a defect to repair — or a dependency is
 * running past the timeouts it declares, which is an operational condition and
 * not a defect at all. Either way the kill has already cost the row one of a
 * finite number of attempts, which is why this fires on the first kill instead
 * of waiting for the dead-letter alert at the end of the retries.
 */
export function createJobLeaseTimeoutEntry(deps: LeaseTimeoutEntryDeps): CronEntry {
  return {
    name: 'job-lease-timeout-audit',
    run: async (): Promise<void> => {
      const types = await deps.probes.findLeaseTimeouts();
      if (types.length === 0) return;
      for (const type of types) {
        deps.telemetry.error('job type killed at its execution budget', {
          jobType: type,
          errorCode: FINGERPRINT_CODES.jobLeaseTimeout,
        });
      }
      deps.telemetry.captureError(
        new Error('job types killed at their execution budget'),
        FINGERPRINT_CODES.jobLeaseTimeout
      );
    },
  };
}
