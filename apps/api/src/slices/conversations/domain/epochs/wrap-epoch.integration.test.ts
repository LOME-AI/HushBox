import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  sharedLinks,
  users,
} from '@hushbox/db';
import { sharedLinkFactory, userFactory } from '@hushbox/db/factories';
import { createConversationsStores } from '../../adapters/stores.js';
import { assertWrapEpochByMemberWithinTx } from './wrap-epoch.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../../test-support/link-credential.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for wrap-epoch member-keyed assertion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUser(): Promise<{ userId: string; publicKey: Uint8Array }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@wrap-epoch.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return { userId, publicKey };
}

async function seatUser(conversationId: string, userId: string): Promise<void> {
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId, privilege: 'write', visibleFromEpoch: 1 });
}

/** Seeds a user + owned conversation at epoch 1, seated, with that epoch's row id. */
async function seedUserAndConversation(): Promise<{
  userId: string;
  conversationId: string;
  epochId: string;
  publicKey: Uint8Array;
}> {
  const { userId, publicKey } = await seedUser();
  const { conversationId, epochId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    confirmationHash: crypto.getRandomValues(new Uint8Array(32)),
  });
  createdConversationIds.push(conversationId);
  await seatUser(conversationId, userId);
  return { userId, conversationId, epochId, publicKey };
}

/** Wraps a member public key into an epoch (the epoch_members row). */
async function seedEpochMember(epochId: string, memberPublicKey: Uint8Array): Promise<void> {
  const wrapped = await stores.epochs.insertWraps([
    { epochId, memberPublicKey, wrap: BYTES, visibleFromEpoch: 1 },
  ]);
  wrapped._unsafeUnwrap();
}

async function seedGuestKey(conversationId: string): Promise<Uint8Array> {
  const { linkPublicKey, linkAuthHash } = mintLinkCredential();
  const rows = await db
    .insert(sharedLinks)
    .values(sharedLinkFactory.build({ conversationId, linkPublicKey, linkAuthHash }))
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const seated = await stores.members.insertLinkMember({
    conversationId,
    linkId,
    privilege: 'write',
    visibleFromEpoch: 1,
  });
  if (seated._unsafeUnwrap() === null) throw new Error('guest seat failed');
  return linkPublicKey;
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

describe('assertWrapEpochByMemberWithinTx', () => {
  it('passes for an active user member public key at the current epoch', async () => {
    const { conversationId, epochId, publicKey } = await seedUserAndConversation();
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(publicKey),
    });

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('passes for an active link-guest member public key at the current epoch', async () => {
    const { conversationId, epochId } = await seedUserAndConversation();
    const guestKey = await seedGuestKey(conversationId);
    await seedEpochMember(epochId, guestKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(guestKey),
    });

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('refuses a missing conversation with not_found', async () => {
    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId: crypto.randomUUID(),
      expectedEpoch: 1,
      memberPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a target epoch that no longer matches currentEpoch with conflict', async () => {
    const { conversationId, epochId, publicKey } = await seedUserAndConversation();
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 2,
      memberPublicKey: toBase64(publicKey),
    });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('refuses a public key that is not a member of the current epoch with forbidden', async () => {
    const { conversationId, epochId, publicKey } = await seedUserAndConversation();
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });

    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses with the rotation-pending code while a departed member still holds the epoch', async () => {
    const { conversationId, epochId, publicKey } = await seedUserAndConversation();
    await seedEpochMember(epochId, publicKey);
    const departed = await seedUser();
    await seatUser(conversationId, departed.userId);
    await seedEpochMember(epochId, departed.publicKey);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, departed.userId)
        )
      );

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(publicKey),
    });

    const error = result._unsafeUnwrapErr();
    expect({ code: error.code, wireCode: error.wireCode }).toEqual({
      code: 'conflict',
      wireCode: ERROR_CODES.ROTATION_PENDING,
    });
  });
});
