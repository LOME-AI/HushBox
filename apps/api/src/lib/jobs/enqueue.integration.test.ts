import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { enqueueWithinTx } from './enqueue.js';
import { jobOutcome } from './outcome.js';
import { RECLAIM_MARGIN_SECONDS, createJobRegistry, enqueueOnlyRegistry } from './registry.js';
import { createJobWakeCollector, grantJobWakes } from './wake-capability.js';
import type { SettlementTx } from '../idempotency/index.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { JobRegistry } from './registry.js';
import type { JobWakeCapable } from './wake-capability.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Every test runs inside a rolled-back transaction, so this file commits no
 * jobs rows and leaves none behind for the next file on this worker slot's
 * database. The handle is granted the job-wake capability the enqueue seam
 * requires; a test that reads the wakes back grants its own collector.
 */
class Rollback extends Error {}

async function withRollback<T>(
  function_: (tx: JobWakeCapable<DbTransaction>) => Promise<T>
): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(grantJobWakes(tx, createJobWakeCollector())) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

let typeCounter = 0;
function freshType(): string {
  typeCounter += 1;
  return `test.enqueue${String(typeCounter)}.v1`;
}

const TEST_MAX_EXECUTION_SECONDS = 60;

function registryWith(type: string, shard?: 'default' | 'bulk'): JobRegistry {
  const registry = createJobRegistry();
  registry.register({
    type,
    schema: z.object({ userId: z.string() }),
    maxExecutionSeconds: TEST_MAX_EXECUTION_SECONDS,
    maxFailures: 5,
    idempotency: 'natural',
    kind: 'oneShot',
    handler: () => Promise.resolve(jobOutcome.ok()),
    ...(shard === undefined ? {} : { shard }),
  });
  return registry;
}

async function readJob(tx: DbTransaction, jobId: string): Promise<typeof jobs.$inferSelect> {
  const rows = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

function requireEnqueued(result: Awaited<ReturnType<typeof enqueueWithinTx>>): string {
  if (!result.enqueued) throw new Error('expected an enqueued job');
  return result.jobId;
}

afterAll(async () => {
  await db.$client.end();
});

describe('enqueueWithinTx', () => {
  it('writes the same row off the handler-free registry view', async () => {
    const type = freshType();
    const registry = registryWith(type, 'bulk');
    const [wide, enqueueOnly] = await withRollback(async (tx) => {
      const a = await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' } });
      const b = await enqueueWithinTx(tx, enqueueOnlyRegistry(registry), {
        type,
        payload: { userId: 'u1' },
      });
      return [await readJob(tx, requireEnqueued(a)), await readJob(tx, requireEnqueued(b))];
    });

    expect({ ...enqueueOnly, id: '', createdAt: null, nextAttemptAt: null }).toEqual({
      ...wide,
      id: '',
      createdAt: null,
      nextAttemptAt: null,
    });
  });

  it('inserts a pending row carrying registry-derived budgets', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row).toMatchObject({
      type,
      shard: 'default',
      priority: 0,
      status: 'pending',
      payload: { userId: 'u1' },
      leaseSeconds: TEST_MAX_EXECUTION_SECONDS + RECLAIM_MARGIN_SECONDS,
      maxFailures: 5,
      maxClaims: 8,
      claims: 0,
      failures: 0,
    });
  });

  it('derives the row lease from the declared execution budget plus the reclaim margin', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
      });
      return readJob(tx, requireEnqueued(result));
    });

    expect(row.leaseSeconds).toBe(65);
    // The property the margin exists for: a handler that runs its whole budget
    // is still inside the reclaim deadline when it writes its terminal row.
    expect(row.leaseSeconds).toBeGreaterThan(TEST_MAX_EXECUTION_SECONDS);
  });

  it('routes to the registration shard by default', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type, 'bulk'), {
        type,
        payload: { userId: 'u1' },
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.shard).toBe('bulk');
  });

  it('honors an explicit shard override', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        shard: 'bulk',
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.shard).toBe('bulk');
  });

  it('honors an explicit priority', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        priority: -5,
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.priority).toBe(-5);
  });

  it('sets a delayed start as both scheduledAt and nextAttemptAt', async () => {
    const type = freshType();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        scheduledAt,
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.scheduledAt.getTime()).toBe(scheduledAt.getTime());
    expect(row.nextAttemptAt.getTime()).toBe(scheduledAt.getTime());
  });

  it('suppresses a duplicate while a dedupe-keyed job is active', async () => {
    const type = freshType();
    const registry = registryWith(type);
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const second = await withRollback(async (tx) => {
      requireEnqueued(
        await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey })
      );
      return enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey });
    });
    expect(second).toEqual({ enqueued: false, reason: 'duplicate-active' });
  });

  it('allows re-enqueue once the dedupe-keyed job reached a terminal state', async () => {
    const type = freshType();
    const registry = registryWith(type);
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const { firstId, second } = await withRollback(async (tx) => {
      const firstJobId = requireEnqueued(
        await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey })
      );
      await tx.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, firstJobId));
      return {
        firstId: firstJobId,
        second: await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey }),
      };
    });
    expect(second.enqueued).toBe(true);
    if (second.enqueued) expect(second.jobId).not.toBe(firstId);
  });

  it('rejects an unregistered type', async () => {
    const registry = createJobRegistry();
    await expect(
      withRollback((tx) =>
        enqueueWithinTx(tx, registry, { type: 'missing.v1', payload: { userId: 'u1' } })
      )
    ).rejects.toThrow('unregistered');
  });

  it('rejects a payload that fails the registered schema', async () => {
    const type = freshType();
    await expect(
      withRollback((tx) =>
        enqueueWithinTx(tx, registryWith(type), { type, payload: { userId: 42 } })
      )
    ).rejects.toThrow('payload');
  });
});

describe('the wake an enqueue leaves behind', () => {
  it('records the registration shard on the handle that granted the capability', async () => {
    const type = freshType();
    const shards = await withRollback(async (tx) => {
      const collector = createJobWakeCollector();
      await enqueueWithinTx(grantJobWakes(tx, collector), registryWith(type, 'bulk'), {
        type,
        payload: { userId: 'u1' },
      });
      return collector.shards();
    });
    expect(shards).toEqual(['bulk']);
  });

  it('records the explicit shard override rather than the registration default', async () => {
    const type = freshType();
    const shards = await withRollback(async (tx) => {
      const collector = createJobWakeCollector();
      await enqueueWithinTx(grantJobWakes(tx, collector), registryWith(type, 'bulk'), {
        type,
        payload: { userId: 'u1' },
        shard: 'default',
      });
      return collector.shards();
    });
    expect(shards).toEqual(['default']);
  });

  it('records nothing when the dedupe key suppressed the insert', async () => {
    const type = freshType();
    const registry = registryWith(type, 'bulk');
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const shards = await withRollback(async (tx) => {
      await enqueueWithinTx(grantJobWakes(tx, createJobWakeCollector()), registry, {
        type,
        payload: { userId: 'u1' },
        dedupeKey,
      });
      const collector = createJobWakeCollector();
      await enqueueWithinTx(grantJobWakes(tx, collector), registry, {
        type,
        payload: { userId: 'u1' },
        dedupeKey,
      });
      return collector.shards();
    });
    expect(shards).toEqual([]);
  });
});

/**
 * The `@ts-expect-error` directives ARE these assertions: each claims the call
 * beneath it does not compile, so an enqueue seam that stopped demanding the
 * capability would report the directive as unused and fail `pnpm typecheck`.
 * The runtime bodies only keep the witnesses referenced.
 */
describe('the handle the enqueue seam demands', () => {
  it('refuses a writer no scope granted', () => {
    const witness = (tx: DbTransaction, registry: JobRegistry): void => {
      // @ts-expect-error -- an ungranted writer carries no collector, so the enqueued row's wake would be dropped
      void enqueueWithinTx(tx, registry, { type: 'x.v1', payload: { userId: 'u1' } });
    };
    expectCompileTimeProof(() => witness);
  });

  it('refuses a settlement transaction no scope granted', () => {
    const witness = (tx: SettlementTx, registry: JobRegistry): void => {
      // @ts-expect-error -- the settlement brand is a separate capability and carries no collector of its own
      void enqueueWithinTx(tx, registry, { type: 'x.v1', payload: { userId: 'u1' } });
    };
    expectCompileTimeProof(() => witness);
  });
});
