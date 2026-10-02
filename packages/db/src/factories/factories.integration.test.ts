import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { conversations, epochs, jobs, sharedLinks, users, wallets } from '../schema/index';
import { placeholderBytes } from './helpers';
import { userFactory, lockedUserFactory } from './user';
import { walletFactory, negativeBalanceWalletFactory } from './wallet';
import { jobFactory, deadJobFactory, discardedJobFactory } from './job';
import { sharedLinkFactory, revokedSharedLinkFactory } from './shared-link';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

let db: Database;
const userIds: string[] = [];
const jobIds: string[] = [];
const walletIds: string[] = [];

beforeAll(() => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
});

afterAll(async () => {
  // Users cascade conversations → shared links; wallets SET NULL.
  if (jobIds.length > 0) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  // Ownerless wallets outlive the user delete above — nothing cascades to them.
  if (walletIds.length > 0) await db.delete(wallets).where(inArray(wallets.id, walletIds));
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

async function insertUser(locked = false): Promise<string> {
  const built = locked ? lockedUserFactory.build() : userFactory.build();
  const [row] = await db.insert(users).values(built).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  userIds.push(row.id);
  return row.id;
}

describe('non-legacy factories insert valid rows', () => {
  it('user + locked user', async () => {
    await insertUser();
    const lockedId = await insertUser(true);
    const [row] = await db
      .select()
      .from(users)
      .where(inArray(users.id, [lockedId]));
    expect(row?.lockedAt).toBeInstanceOf(Date);
    expect(row?.lockReason).toBe('admin');
  });

  it('wallet + negative-balance wallet', async () => {
    const userId = await insertUser();
    const [wallet] = await db.insert(wallets).values(walletFactory.build({ userId })).returning();
    expect(wallet?.balanceNanoUsd).toBe(0n);

    const [negative] = await db
      .insert(wallets)
      .values(negativeBalanceWalletFactory.build({ userId, type: 'free' }))
      .returning();
    expect(negative?.balanceNanoUsd ?? 0n).toBeLessThan(0n);
  });

  it('wallet with the null user id pseudonymization leaves behind', async () => {
    const built = walletFactory.build();
    expect(built.userId).toBeNull();
    const [row] = await db.insert(wallets).values(built).returning();
    if (!row) throw new Error('wallet insert returned no row');
    walletIds.push(row.id);
    expect(row.userId).toBeNull();
  });

  it('job + dead job + discarded job', async () => {
    // `test.noop.v1` carries no registered handler, so a dispatcher that does
    // claim the pending row dead-letters it as an unregistered type; the ids
    // collected below are deleted before this file ends.
    const rows = await db
      .insert(jobs)
      .values([
        jobFactory.build({ shard: 'bulk' }),
        deadJobFactory.build({ shard: 'bulk' }),
        discardedJobFactory.build({ shard: 'bulk' }),
      ])
      .returning();
    expect(rows).toHaveLength(3);
    for (const row of rows) jobIds.push(row.id);
    expect(rows.map((row) => row.status).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'dead',
      'dead',
      'pending',
    ]);
    expect(rows.filter((row) => row.discardedAt !== null)).toHaveLength(1);
  });

  it('shared link + revoked shared link', async () => {
    const userId = await insertUser();
    // `conversations.current_epoch` is a deferred foreign key into `epochs`, so
    // the conversation and its first epoch commit in one transaction.
    const conversationId = await db.transaction(async (tx) => {
      const [conversation] = await tx
        .insert(conversations)
        .values({ userId, title: placeholderBytes(16) })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('conversation insert returned no row');
      await tx.insert(epochs).values({
        conversationId: conversation.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
      });
      return conversation.id;
    });

    const inserted = await db
      .insert(sharedLinks)
      .values([
        sharedLinkFactory.build({ conversationId }),
        revokedSharedLinkFactory.build({ conversationId }),
      ])
      .returning();
    expect(inserted).toHaveLength(2);
    expect(inserted.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });
});
