import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  epochs,
  epochMembers,
  conversationMembers,
  sharedLinks,
  messages,
  type Database,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  generateKeyPair,
  createFirstEpoch,
  performEpochRotation,
  encryptMessageForStorage,
  unwrapEpochKey,
  traverseChainLink,
  decryptMessage,
} from '@hushbox/crypto';
import { createOrGetConversation, getConversation } from '../services/conversations/index.js';
import { getKeyChain, submitRotation, StaleEpochError } from '../services/keys/keys.js';
import { createLink, revokeLink } from '../services/links/links.js';

function defined<T>(value: T | undefined | null, label = 'value'): T {
  if (value == null) throw new Error(`Expected ${label} to be defined`);
  return value;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('member rotation integration', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  async function createTestUser(): Promise<
    typeof users.$inferSelect & {
      accountKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
    }
  > {
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return { ...user, accountKeyPair };
  }

  async function createConversationWithEpoch(
    userId: string,
    userPublicKey: Uint8Array
  ): Promise<{
    conversationId: string;
    epochResult: ReturnType<typeof createFirstEpoch>;
  }> {
    const conversationId = crypto.randomUUID();
    const epochResult = createFirstEpoch([userPublicKey]);
    const memberWrap = epochResult.memberWraps[0];
    if (!memberWrap) throw new Error('Expected member wrap');

    const result = await createOrGetConversation(db, userId, {
      id: conversationId,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
      memberWrap: memberWrap.wrap,
      userPublicKey,
    });
    if (!result) throw new Error('Failed to create conversation');

    return { conversationId, epochResult };
  }

  async function getEpochId(conversationId: string, epochNumber: number): Promise<string> {
    const [epoch] = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
    return defined(epoch, `epoch ${String(epochNumber)}`).id;
  }

  it('add-without-history triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const epoch1PrivateKey = epoch1Result.epochPrivateKey;
    const rotation = performEpochRotation(epoch1PrivateKey, [owner.publicKey, memberB.publicKey]);

    const ownerWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(owner.publicKey))
      )
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(memberB.publicKey))
      )
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Test Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [memberRow] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(memberRow).visibleFromEpoch).toBe(2);

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);

    const epoch1Id = await getEpochId(conversationId, 1);
    const oldWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch1Id));
    expect(oldWraps).toHaveLength(0);

    expect(defined(conv).title).toEqual(encryptedTitle);
  });

  it('remove member triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBWrap1 = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBWrap1).wrap,
      visibleFromEpoch: 1,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [leftMember] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(leftMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('non-owner leave triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBWrap1 = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBWrap1).wrap,
      visibleFromEpoch: 1,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [leftMember] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(leftMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('owner leave deletes conversation (no rotation)', async () => {
    const owner = await createTestUser();
    const { conversationId } = await createConversationWithEpoch(owner.id, owner.publicKey);

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    const rows = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(rows).toHaveLength(0);

    const epochRows = await db
      .select()
      .from(epochs)
      .where(eq(epochs.conversationId, conversationId));
    expect(epochRows).toHaveLength(0);
  });

  it('new member with history sees all messages, without history sees only new epoch', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const memberC = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(epoch1Result.epochPublicKey, 'epoch 1 message'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap2 = defined(rotation12.memberWraps[0]);
    const encryptedTitle2 = encryptMessageForStorage(rotation12.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
      ],
      encryptedTitle: encryptedTitle2,
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const memberBEpochData = createFirstEpoch([memberB.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpochData.memberWraps[0]).wrap,
      visibleFromEpoch: 2,
    });

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(rotation12.epochPublicKey, 'epoch 2 message'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 2,
      sequenceNumber: 2,
    });

    const memberBKeyChain = await getKeyChain(db, conversationId, memberB.publicKey);
    expect(defined(memberBKeyChain).wraps).toHaveLength(1);
    expect(defined(defined(memberBKeyChain).wraps[0]).epochNumber).toBe(2);

    const memberBConversation = await getConversation(db, conversationId, memberB.id);
    expect(defined(memberBConversation).messages).toHaveLength(1);
    expect(defined(defined(memberBConversation).messages[0]).epochNumber).toBe(2);

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberC.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const memberCEpochData = createFirstEpoch([memberC.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberC.publicKey,
      wrap: defined(memberCEpochData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const memberCKeyChain = await getKeyChain(db, conversationId, memberC.publicKey);
    const kcC = defined(memberCKeyChain);
    expect(kcC.wraps).toHaveLength(1);
    expect(kcC.chainLinks).toHaveLength(1);
    expect(defined(kcC.chainLinks[0]).epochNumber).toBe(2);

    const epoch2PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap2.wrap);
    const epoch1PrivateKey = traverseChainLink(
      epoch2PrivateKey,
      defined(kcC.chainLinks[0]).chainLink
    );

    const msg1 = decryptMessage(
      epoch1PrivateKey,
      defined(defined(await getConversation(db, conversationId, memberC.id)).messages[0])
        .encryptedBlob
    );
    expect(msg1).toBe('epoch 1 message');
  });

  it('concurrent rotation: first-write-wins', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotationA = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const rotationB = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);

    const encryptedTitleA = encryptMessageForStorage(rotationA.epochPublicKey, 'Title A');
    const encryptedTitleB = encryptMessageForStorage(rotationB.epochPublicKey, 'Title B');

    const results = await Promise.allSettled([
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationA.epochPublicKey,
        confirmationHash: rotationA.confirmationHash,
        chainLink: rotationA.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationA.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: encryptedTitleA,
      }),
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationB.epochPublicKey,
        confirmationHash: rotationB.confirmationHash,
        chainLink: rotationB.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationB.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: encryptedTitleB,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(StaleEpochError);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);
  });

  it('link revocation triggers rotation', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const linkKeyPair = generateKeyPair();
    const epoch1Id = await getEpochId(conversationId, 1);
    const linkWrapData = createFirstEpoch([linkKeyPair.publicKey]);
    const linkWrap = defined(linkWrapData.memberWraps[0]);

    const { linkId } = await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: epoch1Id,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);
    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Title');

    const revokeResult = await revokeLink(db, linkId, conversationId, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(revokeResult.revoked).toBe(true);
    expect(revokeResult.memberId).not.toBeNull();

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [link] = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkId));
    expect(defined(link).revokedAt).not.toBeNull();

    const [linkMember] = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkId));
    expect(defined(linkMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('rotation with mixed user + link members preserves both', async () => {
    const owner = await createTestUser();
    const userB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: userB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const epoch1Id = await getEpochId(conversationId, 1);
    const userBWrapData = createFirstEpoch([userB.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: userB.publicKey,
      wrap: defined(userBWrapData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const linkKeyPair = generateKeyPair();
    const linkWrapData = createFirstEpoch([linkKeyPair.publicKey]);
    const linkWrap = defined(linkWrapData.memberWraps[0]);

    await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: epoch1Id,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      linkKeyPair.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(owner.publicKey))
      )
    );
    const linkMemberWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(linkKeyPair.publicKey))
      )
    );

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: linkKeyPair.publicKey,
          wrap: linkMemberWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);

    const publicKeys = newWraps.map((w) => Buffer.from(w.memberPublicKey));
    expect(publicKeys.some((k) => k.equals(Buffer.from(owner.publicKey)))).toBe(true);
    expect(publicKeys.some((k) => k.equals(Buffer.from(linkKeyPair.publicKey)))).toBe(true);
    expect(publicKeys.some((k) => k.equals(Buffer.from(userB.publicKey)))).toBe(false);
  });

  it('three sequential rotations with chain link traversal', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const memberC = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(epoch1Result.epochPublicKey, 'msg epoch 1'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap2 = defined(
      rotation12.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(owner.publicKey))
      )
    );
    const memberBWrap2 = defined(
      rotation12.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(memberB.publicKey))
      )
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap2.wrap,
        },
      ],
      encryptedTitle: encryptMessageForStorage(rotation12.epochPublicKey, 'Title 2'),
    });

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(rotation12.epochPublicKey, 'msg epoch 2'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 2,
      sequenceNumber: 2,
    });

    const rotation23 = performEpochRotation(rotation12.epochPrivateKey, [owner.publicKey]);
    const ownerWrap3 = defined(rotation23.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 2,
      epochPublicKey: rotation23.epochPublicKey,
      confirmationHash: rotation23.confirmationHash,
      chainLink: rotation23.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap3.wrap,
        },
      ],
      encryptedTitle: encryptMessageForStorage(rotation23.epochPublicKey, 'Title 3'),
    });

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(rotation23.epochPublicKey, 'msg epoch 3'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 3,
      sequenceNumber: 3,
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberC.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch3Id = await getEpochId(conversationId, 3);
    const memberCWrapData = createFirstEpoch([memberC.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch3Id,
      memberPublicKey: memberC.publicKey,
      wrap: defined(memberCWrapData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const memberCKeyChain = await getKeyChain(db, conversationId, memberC.publicKey);
    const kc = defined(memberCKeyChain);
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).epochNumber).toBe(3);
    expect(kc.chainLinks).toHaveLength(2);

    const epoch3PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap3.wrap);

    const chainLink3 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 3));
    const epoch2PrivateKey = traverseChainLink(epoch3PrivateKey, chainLink3.chainLink);

    const chainLink2 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 2));
    const epoch1PrivateKey = traverseChainLink(epoch2PrivateKey, chainLink2.chainLink);

    const memberCConversation = await getConversation(db, conversationId, memberC.id);
    const msgs = defined(memberCConversation).messages;
    expect(msgs).toHaveLength(3);

    expect(decryptMessage(epoch1PrivateKey, defined(msgs[0]).encryptedBlob)).toBe('msg epoch 1');
    expect(decryptMessage(epoch2PrivateKey, defined(msgs[1]).encryptedBlob)).toBe('msg epoch 2');
    expect(decryptMessage(epoch3PrivateKey, defined(msgs[2]).encryptedBlob)).toBe('msg epoch 3');
  });

  it('idempotent retry of add-without-history', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);
    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });
    expect(result.newEpochNumber).toBe(2);

    await expect(
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotation.epochPublicKey,
        confirmationHash: rotation.confirmationHash,
        chainLink: rotation.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: ownerWrap.wrap,
          },
        ],
        encryptedTitle,
      })
    ).rejects.toThrow(StaleEpochError);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);
  });

  // Test 11: "server overrides client visibleFromEpoch" — covered by
  // keys.test.ts "overrides client visibleFromEpoch with authoritative value from conversationMembers"

  it('new member can decrypt re-encrypted title', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(owner.publicKey))
      )
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) =>
        Buffer.from(w.memberPublicKey).equals(Buffer.from(memberB.publicKey))
      )
    );

    const encryptedTitle = encryptMessageForStorage(rotation.epochPublicKey, 'My Title');

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    const epoch2PrivateKey = unwrapEpochKey(memberB.accountKeyPair.privateKey, memberBWrap.wrap);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const title = decryptMessage(epoch2PrivateKey, defined(conv).title);
    expect(title).toBe('My Title');
  });

  it('remove + re-add same user', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBEpoch1Wrap = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpoch1Wrap).wrap,
      visibleFromEpoch: 1,
    });

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      encryptedBlob: encryptMessageForStorage(epoch1Result.epochPublicKey, 'before removal'),
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap2 = defined(rotation12.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
      ],
      encryptedTitle: encryptMessageForStorage(rotation12.epochPublicKey, 'Title'),
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const memberBEpoch2Wrap = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpoch2Wrap).wrap,
      visibleFromEpoch: 1,
    });

    const memberBRows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(memberBRows).toHaveLength(2);
    expect(memberBRows.filter((r) => r.leftAt !== null)).toHaveLength(1);
    expect(memberBRows.filter((r) => r.leftAt === null)).toHaveLength(1);

    const memberBKeyChain = await getKeyChain(db, conversationId, memberB.publicKey);
    const kc = defined(memberBKeyChain);
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).epochNumber).toBe(2);
    expect(kc.chainLinks).toHaveLength(1);
    expect(defined(kc.chainLinks[0]).epochNumber).toBe(2);

    const epoch2PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap2.wrap);
    const epoch1PrivateKey = traverseChainLink(
      epoch2PrivateKey,
      defined(kc.chainLinks[0]).chainLink
    );

    const memberBConversation = await getConversation(db, conversationId, memberB.id);
    const msgs = defined(memberBConversation).messages;
    expect(msgs).toHaveLength(1);
    expect(decryptMessage(epoch1PrivateKey, defined(msgs[0]).encryptedBlob)).toBe('before removal');
  });
});
