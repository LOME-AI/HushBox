import { sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import { reclaimLeaseSeconds } from './registry.js';
import { collectJobWake } from './wake-capability.js';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobEnqueueRegistry, JobShard } from './registry.js';
import type { JobWakeCapable } from './wake-capability.js';

interface EnqueueJobInput {
  readonly type: string;
  readonly payload: unknown;
  readonly shard?: JobShard;
  readonly priority?: number;
  /**
   * "At most one active" per key: the partial unique index only covers
   * pending/running rows, so finished rows never block re-enqueue.
   */
  readonly dedupeKey?: string;
  /** Delayed start: the dispatcher first attempts the job at this instant. */
  readonly scheduledAt?: Date;
}

export type EnqueueJobResult =
  | { readonly enqueued: true; readonly jobId: string }
  | { readonly enqueued: false; readonly reason: 'duplicate-active' };

/**
 * Pattern C's enqueue: an INSERT inside the caller's domain transaction, so
 * job creation is atomic with the work that requires it. The handle must
 * carry the job-wake capability: every row this inserts leaves its shard on
 * the granting scope's collector, and the boundary discharges the lossy nudge
 * once the transaction has committed — so no caller can forget the wake, and
 * no wake can escape a rolled-back transaction. An unregistered type or
 * schema-violating payload is a caller bug and throws (aborting the
 * transaction); a dedupe conflict is an expected outcome and never aborts
 * (`ON CONFLICT DO NOTHING`) and leaves no wake, because it inserted no row.
 */
export async function enqueueWithinTx(
  tx: JobWakeCapable<DbWriter>,
  registry: JobEnqueueRegistry,
  input: EnqueueJobInput
): Promise<EnqueueJobResult> {
  const registration = registry.get(input.type);
  if (registration === undefined) {
    throw new Error(`enqueueWithinTx: unregistered job type ${JSON.stringify(input.type)}`);
  }
  const parsed = registration.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new Error(`enqueueWithinTx: payload for ${input.type} failed its registered schema`, {
      cause: parsed.error,
    });
  }
  const insert = tx.insert(jobs).values({
    type: registration.type,
    shard: input.shard ?? registration.shard,
    priority: input.priority ?? 0,
    payload: parsed.data,
    leaseSeconds: reclaimLeaseSeconds(registration.maxExecutionSeconds),
    maxFailures: registration.maxFailures,
    maxClaims: registration.maxClaims,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    ...(input.scheduledAt === undefined
      ? {}
      : { scheduledAt: input.scheduledAt, nextAttemptAt: input.scheduledAt }),
  });
  // The shard comes back off the inserted row rather than being recomputed
  // here: the collected shard is then the very column the dispatcher claims
  // on, so it can never disagree with a recomputation, and it is the same
  // spelling redrive uses.
  const returned = { id: jobs.id, shard: jobs.shard };
  const rows =
    input.dedupeKey === undefined
      ? await insert.returning(returned)
      : await insert
          .onConflictDoNothing({
            target: jobs.dedupeKey,
            where: sql`${jobs.status} IN ('pending', 'running')`,
          })
          .returning(returned);
  const row = rows[0];
  if (row === undefined) return { enqueued: false, reason: 'duplicate-active' };
  collectJobWake(tx, row.shard);
  return { enqueued: true, jobId: row.id };
}
