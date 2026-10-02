import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  users,
  type Database,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { seatCurrentEpochHolder, seedConversationWithEpoch } from './conversation-seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined) throw new Error('DATABASE_URL is required');

const BYTES = new Uint8Array([1, 2, 3, 4]);

let db: Database;
const createdUserIds: string[] = [];

beforeAll(() => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // A seated member's user_id is nulled by a user delete, which its identity
    // check refuses on a live seat, so the conversations (and their seats) go first.
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@conversation-seed.test`,
        username: `cs${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row.id;
}

describe('seedConversationWithEpoch', () => {
  it('commits the conversation together with the epoch its current epoch names', async () => {
    const userId = await seedUser();
    const { conversationId } = await seedConversationWithEpoch(db, { userId });

    const [conversation] = await db
      .select({ currentEpoch: conversations.currentEpoch })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const epochRows = await db
      .select({ epochNumber: epochs.epochNumber })
      .from(epochs)
      .where(eq(epochs.conversationId, conversationId));

    expect(conversation?.currentEpoch).toBe(1);
    expect(epochRows.map((row) => row.epochNumber)).toEqual([1]);
  });

  it('returns the row id of the epoch the conversation currently names', async () => {
    const userId = await seedUser();
    const { conversationId, epochId } = await seedConversationWithEpoch(db, { userId });

    const [named] = await db
      .select({ epochNumber: epochs.epochNumber })
      .from(epochs)
      .where(eq(epochs.id, epochId));

    expect(named?.epochNumber).toBe(1);
    expect(conversationId).not.toBe(epochId);
  });

  it('seeds the whole chain up to a rotated current epoch', async () => {
    const userId = await seedUser();
    const { conversationId } = await seedConversationWithEpoch(db, { userId, currentEpoch: 4 });

    const epochRows = await db
      .select({ epochNumber: epochs.epochNumber })
      .from(epochs)
      .where(eq(epochs.conversationId, conversationId))
      .orderBy(asc(epochs.epochNumber));

    expect(epochRows.map((row) => row.epochNumber)).toEqual([1, 2, 3, 4]);
  });

  it('honours a caller-pinned conversation id', async () => {
    const userId = await seedUser();
    const pinned = crypto.randomUUID();

    const { conversationId } = await seedConversationWithEpoch(db, { userId, id: pinned });

    expect(conversationId).toBe(pinned);
  });

  it('stores the caller-supplied epoch public key on the named epoch', async () => {
    const userId = await seedUser();
    const epochPublicKey = crypto.getRandomValues(new Uint8Array(32));

    const { epochId } = await seedConversationWithEpoch(db, { userId, epochPublicKey });

    const [row] = await db
      .select({ epochPublicKey: epochs.epochPublicKey })
      .from(epochs)
      .where(eq(epochs.id, epochId));

    expect(row?.epochPublicKey).toEqual(epochPublicKey);
  });

  it('stores the caller-supplied conversation columns', async () => {
    const userId = await seedUser();
    const title = crypto.getRandomValues(new Uint8Array(16));

    const { conversationId } = await seedConversationWithEpoch(db, {
      userId,
      title,
      conversationBudgetNanoUsd: 7n,
      currentEpoch: 2,
      titleEpochNumber: 2,
    });

    const [row] = await db
      .select({
        title: conversations.title,
        conversationBudgetNanoUsd: conversations.conversationBudgetNanoUsd,
        titleEpochNumber: conversations.titleEpochNumber,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));

    expect(row?.title).toEqual(title);
    expect(row?.conversationBudgetNanoUsd).toBe(7n);
    expect(row?.titleEpochNumber).toBe(2);
  });
});

describe('seatCurrentEpochHolder', () => {
  it("wraps the current epoch to the seated user's own key", async () => {
    const ownerId = await seedUser();
    const { conversationId, epochId } = await seedConversationWithEpoch(db, {
      userId: ownerId,
      currentEpoch: 2,
    });
    const userId = await seedUser();

    await seatCurrentEpochHolder(db, { conversationId, userId });

    const [user] = await db
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, userId));
    const wraps = await db
      .select({ epochId: epochMembers.epochId })
      .from(epochMembers)
      .where(eq(epochMembers.memberPublicKey, user?.publicKey ?? BYTES));
    expect(wraps).toEqual([{ epochId }]);
  });

  it('returns a live write seat for the user', async () => {
    const ownerId = await seedUser();
    const { conversationId } = await seedConversationWithEpoch(db, { userId: ownerId });
    const userId = await seedUser();

    const memberId = await seatCurrentEpochHolder(db, { conversationId, userId });

    const [seat] = await db
      .select({
        conversationId: conversationMembers.conversationId,
        userId: conversationMembers.userId,
        privilege: conversationMembers.privilege,
        leftAt: conversationMembers.leftAt,
      })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    expect(seat).toEqual({ conversationId, userId, privilege: 'write', leftAt: null });
  });

  it('stamps the seat departed while its wrap stays', async () => {
    const ownerId = await seedUser();
    const { conversationId, epochId } = await seedConversationWithEpoch(db, { userId: ownerId });
    const userId = await seedUser();

    const memberId = await seatCurrentEpochHolder(db, { conversationId, userId, departed: true });

    const [seat] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    const wraps = await db
      .select({ id: epochMembers.id })
      .from(epochMembers)
      .where(eq(epochMembers.epochId, epochId));
    expect(seat?.leftAt).toBeInstanceOf(Date);
    expect(wraps).toHaveLength(1);
  });
});
