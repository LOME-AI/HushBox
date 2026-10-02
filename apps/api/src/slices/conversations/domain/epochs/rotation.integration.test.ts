import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { toBase64 } from '@hushbox/shared';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createConversationsStores } from '../../adapters/stores.js';
import { isEpochMember } from '../../adapters/presign-reads.js';
import { applyRotation, epochRowId } from './rotation.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { PlannedWrap } from './rotation.js';
import type { RotationBody } from '../schemas.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for epoch rotation tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const BYTES = new Uint8Array([4, 4, 4]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface Seat {
  readonly userId: string;
  readonly publicKey: Uint8Array;
}

async function seedUser(): Promise<Seat> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@epoch-rotation.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return { userId, publicKey };
}

/** A conversation at epoch 1 whose seats each hold a member row and an epoch-1 wrap. */
async function seedConversation(
  owner: Seat,
  others: readonly Seat[]
): Promise<{ conversationId: string; firstEpochId: string }> {
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId: owner.userId,
    title: BYTES,
  });
  createdConversationIds.push(conversationId);
  const seats = [owner, ...others];
  await db.insert(conversationMembers).values(
    seats.map((seat) => ({
      conversationId,
      userId: seat.userId,
      privilege: seat === owner ? ('owner' as const) : ('write' as const),
      visibleFromEpoch: 1,
    }))
  );
  await db.insert(epochMembers).values(
    seats.map((seat) => ({
      epochId,
      memberPublicKey: seat.publicKey,
      wrap: BYTES,
      visibleFromEpoch: 1,
    }))
  );
  return { conversationId, firstEpochId: epochId };
}

function rotationTo(plan: readonly PlannedWrap[], expectedEpoch: number): RotationBody {
  const b64 = toBase64(BYTES);
  return {
    expectedEpoch,
    epochPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    confirmationHash: b64,
    chainLink: b64,
    memberWraps: plan.map((wrap) => ({ memberPublicKey: wrap.memberPublicKey, wrap: wrap.wrap })),
    encryptedTitle: b64,
  };
}

function planned(seat: Seat, visibleFromEpoch: number): PlannedWrap {
  return { memberPublicKey: toBase64(seat.publicKey), wrap: toBase64(BYTES), visibleFromEpoch };
}

/** One rotation from `expectedEpoch`, chained to that epoch's row, in its own transaction. */
async function rotate(
  conversationId: string,
  expectedEpoch: number,
  plan: readonly PlannedWrap[]
): Promise<void> {
  await db.transaction(async (tx) => {
    const stores = createConversationsStores(tx);
    const rotated = await epochRowId(stores, conversationId, expectedEpoch).andThen(
      (predecessorEpochId) =>
        applyRotation(stores, {
          conversationId,
          rotation: rotationTo(plan, expectedEpoch),
          plan,
          predecessorEpochId,
          writeTitle: true,
        })
    );
    rotated._unsafeUnwrap();
  });
}

/** Every wrap the key holds in the conversation, as the epoch numbers it holds them at. */
async function wrapEpochsOf(conversationId: string, publicKey: Uint8Array): Promise<number[]> {
  const rows = await db
    .select({ epochNumber: epochs.epochNumber })
    .from(epochMembers)
    .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
    .where(
      and(eq(epochs.conversationId, conversationId), eq(epochMembers.memberPublicKey, publicKey))
    )
    .orderBy(epochs.epochNumber);
  return rows.map((row) => row.epochNumber);
}

async function wrapCount(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: epochMembers.id })
    .from(epochMembers)
    .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
    .where(eq(epochs.conversationId, conversationId));
  return rows.length;
}

async function stampLeft(conversationId: string, userId: string): Promise<void> {
  await db
    .update(conversationMembers)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      )
    );
}

/** A fresh member row for a seat that left, visible from `visibleFromEpoch`. */
async function reseat(conversationId: string, seat: Seat, visibleFromEpoch: number): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    userId: seat.userId,
    privilege: 'write',
    visibleFromEpoch,
  });
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('rotation wrap deletion', () => {
  it('leaves no wrap of a dropped key in any epoch of the conversation', async () => {
    const owner = await seedUser();
    const departed = await seedUser();
    const { conversationId } = await seedConversation(owner, [departed]);
    await stampLeft(conversationId, departed.userId);

    await rotate(conversationId, 1, [planned(owner, 1)]);

    expect(await wrapEpochsOf(conversationId, departed.publicKey)).toEqual([]);
  });

  it('keeps every earlier wrap of each remaining member across two rotations', async () => {
    const owner = await seedUser();
    const stays = await seedUser();
    const departed = await seedUser();
    const { conversationId } = await seedConversation(owner, [stays, departed]);
    await stampLeft(conversationId, departed.userId);

    await rotate(conversationId, 1, [planned(owner, 1), planned(stays, 1)]);
    await rotate(conversationId, 2, [planned(owner, 1), planned(stays, 1)]);

    expect(await wrapEpochsOf(conversationId, owner.publicKey)).toEqual([1, 2, 3]);
    expect(await wrapEpochsOf(conversationId, stays.publicKey)).toEqual([1, 2, 3]);
  });

  it('keeps no older wrap of a key this rotation re-seats', async () => {
    const owner = await seedUser();
    const returning = await seedUser();
    const { conversationId } = await seedConversation(owner, [returning]);
    // Left with no rotation — the leaver's epoch-1 wrap survives — then re-added
    // without history, which seats the key at the new epoch.
    await stampLeft(conversationId, returning.userId);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: returning.userId,
      privilege: 'write',
      visibleFromEpoch: 2,
    });
    const before = await wrapCount(conversationId);

    await rotate(conversationId, 1, [planned(owner, 1), planned(returning, 2)]);

    expect(await wrapEpochsOf(conversationId, returning.publicKey)).toEqual([2]);
    expect({ before, after: await wrapCount(conversationId) }).toEqual({ before: 2, after: 3 });
  });

  it('leaves no wrap of a dropped key in the epochs below the predecessor', async () => {
    const owner = await seedUser();
    const departed = await seedUser();
    const { conversationId } = await seedConversation(owner, [departed]);
    await rotate(conversationId, 1, [planned(owner, 1), planned(departed, 1)]);
    await stampLeft(conversationId, departed.userId);

    await rotate(conversationId, 2, [planned(owner, 1)]);

    expect(await wrapEpochsOf(conversationId, departed.publicKey)).toEqual([]);
  });

  it('keeps no wrap below the predecessor of a key this rotation re-seats', async () => {
    const owner = await seedUser();
    const returning = await seedUser();
    const { conversationId } = await seedConversation(owner, [returning]);
    await rotate(conversationId, 1, [planned(owner, 1), planned(returning, 1)]);
    await stampLeft(conversationId, returning.userId);
    await reseat(conversationId, returning, 3);

    await rotate(conversationId, 2, [planned(owner, 1), planned(returning, 3)]);

    expect(await wrapEpochsOf(conversationId, returning.publicKey)).toEqual([3]);
  });

  it("leaves another conversation's wraps standing when a key departs this one", async () => {
    const owner = await seedUser();
    const departed = await seedUser();
    const elsewhereOwner = await seedUser();
    const { conversationId } = await seedConversation(owner, [departed]);
    const elsewhere = await seedConversation(elsewhereOwner, [departed]);
    await stampLeft(conversationId, departed.userId);

    await rotate(conversationId, 1, [planned(owner, 1)]);

    expect({
      departed: await wrapEpochsOf(elsewhere.conversationId, departed.publicKey),
      remaining: await wrapEpochsOf(elsewhere.conversationId, elsewhereOwner.publicKey),
    }).toEqual({ departed: [1], remaining: [1] });
  });

  it("leaves another conversation's wraps standing when a key is re-seated in this one", async () => {
    const owner = await seedUser();
    const returning = await seedUser();
    const elsewhereOwner = await seedUser();
    const { conversationId } = await seedConversation(owner, [returning]);
    const elsewhere = await seedConversation(elsewhereOwner, [returning]);
    await stampLeft(conversationId, returning.userId);
    await reseat(conversationId, returning, 2);

    await rotate(conversationId, 1, [planned(owner, 1), planned(returning, 2)]);

    expect({
      returning: await wrapEpochsOf(elsewhere.conversationId, returning.publicKey),
      remaining: await wrapEpochsOf(elsewhere.conversationId, elsewhereOwner.publicKey),
    }).toEqual({ returning: [1], remaining: [1] });
  });
});

describe('media presign over retained wraps', () => {
  it('admits a member seated at epoch 1 to epoch-1 media after a rotation to epoch 2', async () => {
    const owner = await seedUser();
    const newcomer = await seedUser();
    const { conversationId, firstEpochId } = await seedConversation(owner, []);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: newcomer.userId,
      privilege: 'write',
      visibleFromEpoch: 2,
    });

    await rotate(conversationId, 1, [planned(owner, 1), planned(newcomer, 2)]);

    const admitted = await isEpochMember(db, firstEpochId, { kind: 'user', userId: owner.userId });
    expect(admitted._unsafeUnwrap()).toBe(true);
  });

  it('refuses a member seated at epoch 2 without history epoch-1 media', async () => {
    const owner = await seedUser();
    const newcomer = await seedUser();
    const { conversationId, firstEpochId } = await seedConversation(owner, []);
    await db.insert(conversationMembers).values({
      conversationId,
      userId: newcomer.userId,
      privilege: 'write',
      visibleFromEpoch: 2,
    });

    await rotate(conversationId, 1, [planned(owner, 1), planned(newcomer, 2)]);

    const admitted = await isEpochMember(db, firstEpochId, {
      kind: 'user',
      userId: newcomer.userId,
    });
    expect(admitted._unsafeUnwrap()).toBe(false);
  });
});
