import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  jobs,
  users,
} from '@hushbox/db';
import {
  deadJobFactory,
  discardedJobFactory,
  jobFactory,
  userFactory,
} from '@hushbox/db/factories';
import { createAdminCrossSliceReads } from './admin-read-bindings.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import { holdTableLock } from '../../test-support/hold-table-lock.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin read-binding integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const reads = createAdminCrossSliceReads(db);

const createdUserIds: string[] = [];
const createdJobIds: string[] = [];

/** Commits a jobs row; `createdJobIds` drives the cleanup that deletes it
 * before this file ends. */
async function seedJob(row: ReturnType<typeof jobFactory.build>): Promise<string> {
  const inserted = await db
    .insert(jobs)
    .values({ ...row, shard: 'bulk' })
    .returning({ id: jobs.id });
  const id = inserted[0]!.id;
  createdJobIds.push(id);
  return id;
}

async function seedUser(): Promise<string> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const id = inserted[0]!.id;
  createdUserIds.push(id);
  return id;
}

/** Past the pool's acquisition deadline, so a read queued behind the held one would expire. */
const HOLD_MS = DB_CONNECT_TIMEOUT_MS + 1500;

afterAll(async () => {
  if (createdJobIds.length > 0) await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
  if (createdUserIds.length > 0) {
    // Conversations first: deleting a user SET NULLs member rows, which the
    // identity-or-left check refuses for active memberships; the
    // conversation cascade removes them cleanly.
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('createAdminCrossSliceReads().conversationCounts', () => {
  it('counts owned conversations and active memberships, ignoring left rows', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const title = new Uint8Array([1]);
    const first = await seedConversationWithEpoch(db, { userId: owner, title });
    const second = await seedConversationWithEpoch(db, { userId: owner, title });
    const foreign = await seedConversationWithEpoch(db, { userId: other, title });
    await db.insert(conversationMembers).values([
      { conversationId: first.conversationId, userId: owner, visibleFromEpoch: 1 },
      { conversationId: second.conversationId, userId: owner, visibleFromEpoch: 1 },
      // A membership the user left — never counted.
      {
        conversationId: foreign.conversationId,
        userId: owner,
        visibleFromEpoch: 1,
        leftAt: new Date(),
      },
    ]);

    const counts = await reads.conversationCounts(owner);

    expect(counts).toEqual({ owned: 2, activeMemberships: 2 });
  });

  it(
    'counts memberships when the owned count is held past the acquisition deadline',
    async () => {
      const owner = await seedUser();
      const requestDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
      // The owned count reads `conversations` first; memberships follow it.
      const { released } = await holdTableLock(conversations, HOLD_MS);
      try {
        const counts = await createAdminCrossSliceReads(requestDb).conversationCounts(owner);

        expect(counts).toEqual({ owned: 0, activeMemberships: 0 });
      } finally {
        await released;
        await requestDb.$client.end();
      }
    },
    HOLD_MS * 3
  );
});

describe('createAdminCrossSliceReads().jobsTouchingUser', () => {
  it('returns jobs whose payload names the user, newest first', async () => {
    const userId = await seedUser();
    const hit = await seedJob(jobFactory.build({ payload: { userId } }));
    await seedJob(jobFactory.build({ payload: { userId: crypto.randomUUID() } }));
    await seedJob(jobFactory.build({ payload: {} }));

    const rows = await reads.jobsTouchingUser(userId, 10);

    expect(rows.map((row) => row.id)).toEqual([hit]);
  });
});

describe('createAdminCrossSliceReads().listJobs', () => {
  it('filters by type and status, newest first, with cursor pagination', async () => {
    const type = `admin-read-bindings-test.${crypto.randomUUID()}.v1`;
    const oldest = await seedJob(jobFactory.build({ type }));
    const dead = await seedJob(deadJobFactory.build({ type }));
    const newest = await seedJob(jobFactory.build({ type }));

    const all = await reads.listJobs({ type, limit: 2 });
    expect(all.rows.map((row) => row.id)).toEqual([newest, dead]);
    expect(all.nextCursor).toBe(dead);

    const rest = await reads.listJobs({ type, limit: 2, cursor: all.nextCursor! });
    expect(rest.rows.map((row) => row.id)).toEqual([oldest]);
    expect(rest.nextCursor).toBeNull();

    const deadOnly = await reads.listJobs({ type, status: 'dead', limit: 10 });
    expect(deadOnly.rows.map((row) => row.id)).toEqual([dead]);
  });

  it('reports no next cursor when the last page is exactly full', async () => {
    const type = `admin-read-bindings-test.${crypto.randomUUID()}.v1`;
    const oldest = await seedJob(jobFactory.build({ type }));
    const newest = await seedJob(jobFactory.build({ type }));

    const page = await reads.listJobs({ type, limit: 2 });

    expect(page.rows.map((row) => row.id)).toEqual([newest, oldest]);
    expect(page.nextCursor).toBeNull();
  });

  it('separates discarded rows from the live dead-letter inbox', async () => {
    const type = `admin-read-bindings-test.${crypto.randomUUID()}.v1`;
    const dead = await seedJob(deadJobFactory.build({ type }));
    const discarded = await seedJob(discardedJobFactory.build({ type }));

    const deadOnly = await reads.listJobs({ type, status: 'dead', limit: 10 });
    const discardedOnly = await reads.listJobs({ type, status: 'discarded', limit: 10 });

    expect(deadOnly.rows.map((row) => row.id)).toEqual([dead]);
    expect(deadOnly.rows[0]).toMatchObject({ discarded: false });
    expect(discardedOnly.rows.map((row) => row.id)).toEqual([discarded]);
    expect(discardedOnly.rows[0]).toMatchObject({ discarded: true, status: 'dead' });
  });
});

describe('createAdminCrossSliceReads().listJobs plain-status filters', () => {
  it('filters a non-dead status directly and ignores foreign statuses', async () => {
    const type = `admin-read-bindings-test.${crypto.randomUUID()}.v1`;
    const pending = await seedJob(jobFactory.build({ type }));
    await seedJob(deadJobFactory.build({ type }));

    const pendingOnly = await reads.listJobs({ type, status: 'pending', limit: 10 });

    expect(pendingOnly.rows.map((row) => row.id)).toEqual([pending]);
  });
});

describe('createAdminCrossSliceReads().jobCounts', () => {
  it('counts backlog, dead, and discarded rows', async () => {
    await seedJob(jobFactory.build());
    await seedJob(deadJobFactory.build());
    await seedJob(discardedJobFactory.build());
    await seedJob({ ...jobFactory.build(), status: 'running' });

    // A cancelled row lands in no counter bucket.
    await seedJob({ ...jobFactory.build(), status: 'cancelled' });

    const counts = await reads.jobCounts();

    // The table is shared across suites, so assert floors, not equality.
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    expect(counts.dead).toBeGreaterThanOrEqual(1);
    expect(counts.discarded).toBeGreaterThanOrEqual(1);
    expect(counts.running).toBeGreaterThanOrEqual(1);
  });
});

describe('createAdminCrossSliceReads().userAccountFacts', () => {
  it('returns the account facts for an existing user', async () => {
    const userId = await seedUser();

    const facts = await reads.userAccountFacts(userId);

    expect(facts?.createdAt).toBeInstanceOf(Date);
    expect(facts?.lockReason ?? null).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    const facts = await reads.userAccountFacts(crypto.randomUUID());

    expect(facts).toBeNull();
  });
});
