import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { runSettlement, runSettlementSavepoint } from './settlement.js';
import { collectJobWake, createJobWakeCollector, grantJobWakes } from '../jobs/wake-capability.js';
import type { SettlementTx } from './brands.js';
import type { Database } from '@hushbox/db';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * A second client, on its own pool: the settlement's own client holds a single
 * connection for the length of the transaction, so only an independent one can
 * observe what a concurrent reader sees while the body is still running.
 */
const observer = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * A third client, kept apart from `db`: the wake grant is written onto the
 * handle itself, so granting the shared client would leave every other case in
 * this file merging into a collector it never asked for.
 */
const wakeClient = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

function freshUserId(): string {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return userId;
}

/** A money-write stand-in: the signature every `*WithinTx` helper uses. */
async function writeWithinTx(tx: SettlementTx, userId: string): Promise<void> {
  await tx.insert(idempotencyKeys).values({
    userId,
    route: '/settlement',
    key: crypto.randomUUID(),
    kind: 'run',
    bodyHash: 'settled',
    claimedBy: 'settler',
  });
}

async function countRows(userId: string, client: Database = db): Promise<number> {
  const rows = await client
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.userId, userId));
  return rows.length;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await observer.$client.end();
  await wakeClient.$client.end();
});

describe('runSettlement', () => {
  it('keeps the body writes invisible to a concurrent reader until it returns, then commits both', async () => {
    const userId = freshUserId();
    let visibleMidBody = -1;
    const outcome = await runSettlement(db, async (tx) => {
      await writeWithinTx(tx, userId);
      visibleMidBody = await countRows(userId, observer);
      await writeWithinTx(tx, userId);
      return 'settled';
    });
    expect(outcome).toBe('settled');
    // Zero mid-body is what separates one transaction from a commit per write:
    // a split implementation leaks the first row to the reader here.
    expect(visibleMidBody).toBe(0);
    expect(await countRows(userId)).toBe(2);
  });

  it('rejects a plain transaction where the settlement capability is required', () => {
    const requireSettlement = (tx: SettlementTx): SettlementTx => tx;
    const plainTransactionWitness = (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
    ): void => {
      // @ts-expect-error — only runSettlement can mint SettlementTx; a plain transaction cannot carry money writes
      requireSettlement(tx);
    };
    // The `@ts-expect-error` is the assertion: it claims the marked call does
    // not compile, so a `SettlementTx` that stopped being distinct from a plain
    // transaction handle would flag the directive as unused and fail
    // `pnpm typecheck`. The runtime call only keeps the witness referenced.
    expectCompileTimeProof(() => plainTransactionWitness);
  });

  it('merges the transaction handle wakes into the caller collector once the body commits', async () => {
    const collector = createJobWakeCollector();
    const userId = freshUserId();
    await runSettlement(grantJobWakes(wakeClient, collector), async (tx) => {
      collectJobWake(tx, 'bulk');
      await writeWithinTx(tx, userId);
    });
    expect(collector.shards()).toEqual(['bulk']);
    expect(await countRows(userId)).toBe(1);
  });

  it('merges nothing into the caller collector when the body throws', async () => {
    const collector = createJobWakeCollector();
    const userId = freshUserId();
    await expect(
      runSettlement(grantJobWakes(wakeClient, collector), async (tx) => {
        collectJobWake(tx, 'bulk');
        await writeWithinTx(tx, userId);
        throw new Error('settlement aborted');
      })
    ).rejects.toThrow('settlement aborted');
    expect(collector.shards()).toEqual([]);
    expect(await countRows(userId)).toBe(0);
  });

  it('rolls back every write when the body throws', async () => {
    const userId = freshUserId();
    await expect(
      runSettlement(db, async (tx) => {
        await writeWithinTx(tx, userId);
        throw new Error('settlement aborted');
      })
    ).rejects.toThrow('settlement aborted');
    expect(await countRows(userId)).toBe(0);
  });
});

describe('runSettlementSavepoint', () => {
  it('rolls back only the savepoint body when it throws, and the settlement commits its own writes', async () => {
    const outerUserId = freshUserId();
    const savepointUserId = freshUserId();
    await runSettlement(db, async (tx) => {
      await writeWithinTx(tx, outerUserId);
      await expect(
        runSettlementSavepoint(tx, async (savepoint) => {
          await writeWithinTx(savepoint, savepointUserId);
          throw new Error('savepoint refused');
        })
      ).rejects.toThrow('savepoint refused');
      await writeWithinTx(tx, outerUserId);
    });
    expect(await countRows(savepointUserId)).toBe(0);
    expect(await countRows(outerUserId)).toBe(2);
  });

  it('commits the savepoint body writes with the settlement when the body returns', async () => {
    const userId = freshUserId();
    const outcome = await runSettlement(db, (tx) =>
      runSettlementSavepoint(tx, async (savepoint) => {
        await writeWithinTx(savepoint, userId);
        return 'kept';
      })
    );
    expect(outcome).toBe('kept');
    expect(await countRows(userId)).toBe(1);
  });

  it('rolls the savepoint body back with the settlement when the settlement throws after it', async () => {
    const userId = freshUserId();
    await expect(
      runSettlement(db, async (tx) => {
        await runSettlementSavepoint(tx, (savepoint) => writeWithinTx(savepoint, userId));
        throw new Error('settlement aborted');
      })
    ).rejects.toThrow('settlement aborted');
    expect(await countRows(userId)).toBe(0);
  });

  it('merges the savepoint body wakes into the settlement once the body returns', async () => {
    const collector = createJobWakeCollector();
    await runSettlement(grantJobWakes(wakeClient, collector), (tx) =>
      runSettlementSavepoint(tx, (savepoint) => {
        collectJobWake(savepoint, 'bulk');
        return Promise.resolve();
      })
    );
    expect(collector.shards()).toEqual(['bulk']);
  });

  it('merges nothing from a savepoint body that throws', async () => {
    const collector = createJobWakeCollector();
    await runSettlement(grantJobWakes(wakeClient, collector), async (tx) => {
      await expect(
        runSettlementSavepoint(tx, (savepoint) => {
          collectJobWake(savepoint, 'bulk');
          return Promise.reject(new Error('savepoint refused'));
        })
      ).rejects.toThrow('savepoint refused');
    });
    expect(collector.shards()).toEqual([]);
  });

  it('opens only inside a settlement: a plain transaction cannot enter it', () => {
    const plainTransactionWitness = (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
    ): Promise<void> =>
      // @ts-expect-error: the savepoint takes the settlement capability; a plain transaction never mints one
      runSettlementSavepoint(tx, () => Promise.resolve());
    // The `@ts-expect-error` is the assertion, as in the settlement case above:
    // a savepoint entry that accepted a plain transaction would mint the brand
    // outside a settlement, and the unused directive would fail typecheck.
    expectCompileTimeProof(() => plainTransactionWitness);
  });
});
