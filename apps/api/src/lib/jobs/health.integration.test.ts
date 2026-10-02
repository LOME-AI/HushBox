import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { claimBatch } from './claim.js';
import { completeFail } from './complete.js';
import {
  LEASE_TIMEOUT_WINDOW_SECONDS,
  STUCK_PENDING_GRACE_SECONDS,
  STUCK_RUNNING_LEASE_MULTIPLIER,
  findLeaseTimeoutTypes,
  findStuckJobs,
} from './health.js';
import { LEASE_TIMEOUT_ERROR, LEASE_TIMEOUT_ERROR_PREFIX } from './lease-timeout.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { JobFence } from './complete.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

class Rollback extends Error {}

// Every test runs inside a rolled-back transaction, so this file commits no
// jobs rows and leaves none behind for the next file on this worker slot's
// database. Most assertions read back only the ids the test inserted; the
// limit-and-ordering case reads `findStuckJobs` unfiltered, so it does depend
// on the table holding no older stuck row.
async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

interface JobSeed {
  readonly status: 'pending' | 'running';
  readonly nextAttemptSecondsAgo: number;
  readonly cancelRequested?: boolean;
  readonly claims?: number;
  readonly claimedSecondsAgo?: number;
  readonly leaseSeconds?: number;
}

async function insertJob(tx: DbTransaction, seed: JobSeed): Promise<string> {
  const rows = await tx
    .insert(jobs)
    .values({
      type: 'test.health.v1',
      shard: 'bulk',
      payload: {},
      status: seed.status,
      cancelRequested: seed.cancelRequested ?? false,
      claims: seed.claims ?? 0,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: seed.leaseSeconds ?? 60,
      nextAttemptAt: sql`now() - make_interval(secs => ${seed.nextAttemptSecondsAgo})`,
      claimedAt:
        seed.claimedSecondsAgo === undefined
          ? null
          : sql`now() - make_interval(secs => ${seed.claimedSecondsAgo})`,
      claimedBy: seed.claimedSecondsAgo === undefined ? null : 'health-test',
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert job row');
  return row.id;
}

async function stuckIds(tx: DbTransaction): Promise<Set<string>> {
  const rows = await findStuckJobs(tx, { limit: 100 });
  return new Set(rows.map((row) => row.id));
}

afterAll(async () => {
  await db.$client.end();
});

describe('findStuckJobs', () => {
  it('flags a claimable pending row past the grace window', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(true);
  });

  it('ignores a pending row still inside the grace window', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, { status: 'pending', nextAttemptSecondsAgo: 60 });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('ignores a cancel-requested pending row (the sweep owns it, not the claim path)', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
        cancelRequested: true,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('ignores a pending row past its claim budget (the dead-letter pass owns it)', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
        claims: 8,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('flags a running row stuck past twice its lease', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'running',
        nextAttemptSecondsAgo: 0,
        claimedSecondsAgo: 60 * STUCK_RUNNING_LEASE_MULTIPLIER + 30,
        leaseSeconds: 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(true);
  });

  it('ignores a running row inside twice its lease', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'running',
        nextAttemptSecondsAgo: 0,
        claimedSecondsAgo: 90,
        leaseSeconds: 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('returns at most the limit, oldest due first', async () => {
    const observed = await withRollback(async (tx) => {
      const older = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 7200,
      });
      await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 3600,
      });
      const rows = await findStuckJobs(tx, { limit: 1 });
      return { count: rows.length, first: rows[0]?.id, older };
    });
    expect(observed.count).toBe(1);
    expect(observed.first).toBe(observed.older);
  });
});

let leaseTimeoutTypeCounter = 0;
function freshLeaseTimeoutType(): string {
  leaseTimeoutTypeCounter += 1;
  return `test.lease-timeout${String(leaseTimeoutTypeCounter)}.v1`;
}

interface RecordedFailureSeed {
  readonly type: string;
  readonly status?: 'pending' | 'dead';
  readonly recordedSecondsAgo: number;
  readonly error?: string;
}

/**
 * A row carrying one recorded failure, aged on the database clock the probe's
 * window is measured against.
 */
async function insertRecordedFailure(tx: DbTransaction, seed: RecordedFailureSeed): Promise<void> {
  const error = seed.error ?? `${LEASE_TIMEOUT_ERROR_PREFIX} handler exceeded its budget`;
  await tx.insert(jobs).values({
    type: seed.type,
    shard: 'bulk',
    payload: {},
    status: seed.status ?? 'pending',
    maxClaims: 8,
    maxFailures: 5,
    failures: 1,
    leaseSeconds: 60,
    errors: sql`jsonb_build_array(jsonb_build_object(
        'at', (now() - make_interval(secs => ${seed.recordedSecondsAgo}))::text,
        'claim', 1,
        'error', ${error}::text
      ))`,
  });
}

/** Due far enough back that the shared-shard claim reaches this row ahead of
 * whatever a neighbouring test left claimable. */
const LONG_OVERDUE_SECONDS = 86_400;

/**
 * Records one budget kill the way the executor does: a real claim for a live
 * fence, then the completion writer. A test that builds the entry itself
 * proves only that the probe parses what the test wrote; driving the writer is
 * what shows the builder's SQL executes and that the probe's `::timestamptz`
 * cast parses the `now()::text` stamp it emits — neither of which the key
 * names' compile-time pin in `apps/api/src/lib/jobs/recorded-error.ts` reaches.
 */
async function recordKillThroughWriter(tx: DbTransaction, type: string): Promise<void> {
  const inserted = await tx
    .insert(jobs)
    .values({
      type,
      shard: 'bulk',
      payload: {},
      status: 'pending',
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: 60,
      nextAttemptAt: sql`now() - make_interval(secs => ${LONG_OVERDUE_SECONDS})`,
    })
    .returning({ id: jobs.id });
  const seeded = inserted[0];
  if (seeded === undefined) throw new Error('failed to insert job row');
  const claimed = await claimBatch(tx, {
    shard: 'bulk',
    claimantId: 'health-writer-test',
    limit: 100,
  });
  const row = claimed.find((candidate) => candidate.id === seeded.id);
  if (row === undefined) throw new Error('the seeded row was not claimed');
  const { claimedBy } = row;
  if (claimedBy === null) throw new Error('the claimed row carries no claimant');
  const fence: JobFence = { jobId: row.id, claimedBy, claims: row.claims };
  const outcome = await completeFail(tx, fence, {
    error: LEASE_TIMEOUT_ERROR,
    backoffSeconds: 60,
  });
  if (outcome !== 'repended') throw new Error(`completeFail did not apply the fence: ${outcome}`);
}

describe('findLeaseTimeoutTypes', () => {
  it('reports a type whose row recorded a budget kill inside the window', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, { type, recordedSecondsAgo: 60 });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).toContain(type);
  });

  it('ignores a budget kill recorded before the window', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, {
        type,
        recordedSecondsAgo: LEASE_TIMEOUT_WINDOW_SECONDS + 600,
      });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).not.toContain(type);
  });

  it('ignores a recorded failure that is not a budget kill', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, {
        type,
        recordedSecondsAgo: 60,
        error: 'provider refused the request',
      });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).not.toContain(type);
  });

  it('names a type once however many of its rows were killed', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, { type, recordedSecondsAgo: 60 });
      await insertRecordedFailure(tx, { type, recordedSecondsAgo: 120 });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported.filter((reportedType) => reportedType === type)).toEqual([type]);
  });

  it('names every type that was killed inside the window', async () => {
    const first = freshLeaseTimeoutType();
    const second = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, { type: first, recordedSecondsAgo: 60 });
      await insertRecordedFailure(tx, { type: second, recordedSecondsAgo: 60 });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).toEqual(expect.arrayContaining([first, second]));
  });

  it('reports a type whose kill the completion writer recorded inside the window', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await recordKillThroughWriter(tx, type);
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).toContain(type);
  });

  it('ignores a writer-recorded kill that falls before the window', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await recordKillThroughWriter(tx, type);
      // The writer stamps the entry from the transaction clock the probe
      // measures its window against, so the entry cannot be aged where it
      // lies; opening the window after it is the only aging that writes no
      // instant.
      return findLeaseTimeoutTypes(tx, { windowSeconds: -LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).not.toContain(type);
  });

  it('never scans a terminal row, so a dead type reaches the dead-letter alert alone', async () => {
    const type = freshLeaseTimeoutType();
    const reported = await withRollback(async (tx) => {
      await insertRecordedFailure(tx, { type, status: 'dead', recordedSecondsAgo: 60 });
      return findLeaseTimeoutTypes(tx, { windowSeconds: LEASE_TIMEOUT_WINDOW_SECONDS });
    });
    expect(reported).not.toContain(type);
  });
});
