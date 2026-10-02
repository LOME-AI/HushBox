import { jobs } from '@hushbox/db';
import { reclaimLeaseSeconds } from './registry.js';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobShard } from './registry.js';

/**
 * Dev/E2E fixture rows in the dead inbox, published so dev tooling seeds an
 * admin-op target through the module that owns the `jobs` table. The job type
 * and payload are the caller's: a redrive must be able to succeed, so the
 * payload has to be legal by the registered schema of the type it names.
 */

interface DeadJobFixture {
  /** Caller-chosen so a fixed seed converges; fresh-id callers never conflict. */
  readonly id: string;
  readonly type: typeof jobs.$inferInsert.type;
  readonly shard: JobShard;
  readonly payload: typeof jobs.$inferInsert.payload;
  /** Discarded rows are the `job.restore` target; undiscarded, the redrive one. */
  readonly discarded: boolean;
  /**
   * Whether a row already at this id is rewritten to the state below. True
   * only for a caller that owns its ids and must converge them — an admin op
   * run against a fixed-id row otherwise leaves drift no later seed can undo.
   * A fresh-id caller sets false: its rows are its own and never conflict.
   */
  readonly reassertExisting: boolean;
}

/** The spent budgets a dead row carries — failures exhausted, claims spent. */
const FIXTURE_FAILURES = 8;
const FIXTURE_CLAIMS = 8;
const FIXTURE_MAX_CLAIMS = 10;
const FIXTURE_MAX_EXECUTION_SECONDS = 300;

/**
 * A dead (optionally discarded) job row. A conflicting id is left standing,
 * or rewritten to every column below, per the fixture's `reassertExisting`.
 */
export async function insertDeadJob(writer: DbWriter, fixture: DeadJobFixture): Promise<void> {
  const now = new Date();
  const state = {
    type: fixture.type,
    shard: fixture.shard,
    payload: fixture.payload,
    status: 'dead',
    claims: FIXTURE_CLAIMS,
    maxClaims: FIXTURE_MAX_CLAIMS,
    failures: FIXTURE_FAILURES,
    maxFailures: FIXTURE_FAILURES,
    leaseSeconds: reclaimLeaseSeconds(FIXTURE_MAX_EXECUTION_SECONDS),
    errors: [
      {
        at: now.toISOString(),
        claim: FIXTURE_CLAIMS,
        error: 'seeded dead job (admin op target)',
      },
    ],
    finishedAt: now,
    // Explicit rather than omitted: an undiscarded fixture must clear a
    // discard marker a `job.discard` op left on the row, not inherit it.
    discardedAt: fixture.discarded ? now : null,
  } satisfies Omit<typeof jobs.$inferInsert, 'id'>;
  const insert = writer.insert(jobs).values({ id: fixture.id, ...state });
  await (fixture.reassertExisting
    ? insert.onConflictDoUpdate({ target: jobs.id, set: state })
    : insert.onConflictDoNothing({ target: jobs.id }));
}
