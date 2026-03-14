import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  conversations,
  conversationMembers,
  conversationSpending,
  memberBudgets,
  epochs,
  wallets,
  usageRecords,
  ledgerEntries,
  conversationForks,
  type Database,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  walletFactory,
  conversationForkFactory,
  conversationMemberFactory,
} from '@hushbox/db/factories';
import { createFirstEpoch, decryptMessage, generateKeyPair } from '@hushbox/crypto';
import {
  assignSequenceNumbers,
  fetchEpochPublicKey,
  insertEncryptedMessage,
  chargeAndTrackUsage,
  updateForkTip,
  resolveParentMessageId,
} from './message-helpers.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
  epoch: typeof epochs.$inferSelect;
  wallet: typeof wallets.$inferSelect;
  epochPrivateKey: Uint8Array;
}

async function createTestSetup(db: Database, balance = '10.00000000'): Promise<TestSetup> {
  const accountKeyPair = generateKeyPair();
  const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
  const [createdEpoch] = await db
    .insert(epochs)
    .values({
      conversationId: createdConv.id,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    })
    .returning();
  if (!createdEpoch) throw new Error('Failed to create test epoch');

  const walletData = walletFactory.build({
    userId: createdUser.id,
    type: 'purchased',
    balance,
    priority: 0,
  });
  const [createdWallet] = await db.insert(wallets).values(walletData).returning();
  if (!createdWallet) throw new Error('Failed to create test wallet');

  return {
    user: createdUser,
    conversation: createdConv,
    epoch: createdEpoch,
    wallet: createdWallet,
    epochPrivateKey: epochResult.epochPrivateKey,
  };
}

describe('message-helpers', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      const userWallets = await db
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.userId, userId));
      if (userWallets.length > 0) {
        await db.delete(ledgerEntries).where(
          inArray(
            ledgerEntries.walletId,
            userWallets.map((w) => w.id)
          )
        );
      }
      await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
      await db.delete(wallets).where(eq(wallets.userId, userId));
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  describe('assignSequenceNumbers', () => {
    it('assigns a single sequence number', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await assignSequenceNumbers(db, setup.conversation.id, 1);

      expect(result.sequences).toEqual([1]);
      expect(result.currentEpoch).toBe(1);
    });

    it('assigns two sequence numbers for a chat turn', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await assignSequenceNumbers(db, setup.conversation.id, 2);

      expect(result.sequences).toEqual([1, 2]);
      expect(result.currentEpoch).toBe(1);
    });

    it('assigns three sequence numbers', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await assignSequenceNumbers(db, setup.conversation.id, 3);

      expect(result.sequences).toEqual([1, 2, 3]);
      expect(result.currentEpoch).toBe(1);
    });

    it('increments from previous allocation', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await assignSequenceNumbers(db, setup.conversation.id, 2);
      const result = await assignSequenceNumbers(db, setup.conversation.id, 1);

      expect(result.sequences).toEqual([3]);
    });

    it('throws when conversation does not exist', async () => {
      await expect(assignSequenceNumbers(db, 'nonexistent-conv-id', 1)).rejects.toThrow(
        'Conversation not found'
      );
    });
  });

  describe('fetchEpochPublicKey', () => {
    it('returns the epoch public key and number', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await fetchEpochPublicKey(db, setup.conversation.id, 1);

      expect(result.epochPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.epochPublicKey.length).toBeGreaterThan(0);
      expect(result.epochNumber).toBe(1);
    });

    it('throws when epoch does not exist', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await expect(fetchEpochPublicKey(db, setup.conversation.id, 999)).rejects.toThrow(
        'Epoch not found'
      );
    });

    it('throws when conversation does not exist', async () => {
      await expect(fetchEpochPublicKey(db, 'nonexistent-conv-id', 1)).rejects.toThrow(
        'Epoch not found'
      );
    });
  });

  describe('insertEncryptedMessage', () => {
    it('inserts a user message that can be decrypted', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'Hello from user',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 0,
        senderType: 'user',
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const [inserted] = await db.select().from(messages).where(eq(messages.id, msgId));

      expect(inserted).toBeDefined();
      expect(inserted!.senderType).toBe('user');
      expect(inserted!.senderId).toBe(setup.user.id);
      expect(inserted!.sequenceNumber).toBe(0);
      expect(inserted!.epochNumber).toBe(1);

      const decrypted = decryptMessage(setup.epochPrivateKey, inserted!.encryptedBlob);
      expect(decrypted).toBe('Hello from user');
    });

    it('inserts an AI message without senderId', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'AI response',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'ai',
        modelName: 'test-model',
        cost: '0.00100000',
        parentMessageId: null,
      });

      const [inserted] = await db.select().from(messages).where(eq(messages.id, msgId));

      expect(inserted).toBeDefined();
      expect(inserted!.senderType).toBe('ai');
      expect(inserted!.senderId).toBeNull();
      expect(inserted!.cost).toBe('0.00100000');
    });

    it('inserts a message with parentMessageId', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const parentId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: parentId,
        conversationId: setup.conversation.id,
        content: 'Parent message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 0,
        senderType: 'user',
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const childId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: childId,
        conversationId: setup.conversation.id,
        content: 'Child message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'ai',
        modelName: 'test-model',
        parentMessageId: parentId,
      });

      const [child] = await db.select().from(messages).where(eq(messages.id, childId));

      expect(child).toBeDefined();
      expect(child!.parentMessageId).toBe(parentId);
    });

    it('inserts an AI message with modelName', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'AI response',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'ai',
        cost: '0.00100000',
        modelName: 'GPT-4o',
        parentMessageId: null,
      });

      const [inserted] = await db.select().from(messages).where(eq(messages.id, msgId));

      expect(inserted).toBeDefined();
      expect(inserted!.senderType).toBe('ai');
      expect(inserted!.modelName).toBe('GPT-4o');
    });

    it('inserts a message with payerId', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'Paid message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 0,
        senderType: 'ai',
        modelName: 'test-model',
        payerId: setup.user.id,
        cost: '0.00200000',
        parentMessageId: null,
      });

      const [inserted] = await db.select().from(messages).where(eq(messages.id, msgId));

      expect(inserted).toBeDefined();
      expect(inserted!.payerId).toBe(setup.user.id);
      expect(inserted!.cost).toBe('0.00200000');
    });
  });

  describe('chargeAndTrackUsage', () => {
    it('charges the user wallet and returns usage record ID', async () => {
      const setup = await createTestSetup(db, '10.00000000');
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      const result = await chargeAndTrackUsage(db, {
        userId: setup.user.id,
        cost: '0.00100000',
        model: 'openai/gpt-4o',
        assistantMessageId: msgId,
        conversationId: setup.conversation.id,
        inputTokens: 100,
        outputTokens: 50,
      });

      expect(result.usageRecordId).toBeDefined();
      expect(typeof result.usageRecordId).toBe('string');

      // Verify wallet was charged
      const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
      expect(wallet).toBeDefined();
      expect(Number(wallet!.balance)).toBeLessThan(10);
    });

    it('charges with cachedTokens', async () => {
      const setup = await createTestSetup(db, '10.00000000');
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      const result = await chargeAndTrackUsage(db, {
        userId: setup.user.id,
        cost: '0.00050000',
        model: 'openai/gpt-4o',
        assistantMessageId: msgId,
        conversationId: setup.conversation.id,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
      });

      expect(result.usageRecordId).toBeDefined();
    });

    it('charges with groupBillingContext', async () => {
      const setup = await createTestSetup(db, '10.00000000');
      createdUserIds.push(setup.user.id);

      // Create a conversation member for group spending
      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        privilege: 'owner',
      });
      const [member] = await db.insert(conversationMembers).values(memberData).returning();
      if (!member) throw new Error('Failed to create test member');
      const memberId = member.id;

      const msgId = crypto.randomUUID();
      const result = await chargeAndTrackUsage(db, {
        userId: setup.user.id,
        cost: '0.00100000',
        model: 'openai/gpt-4o',
        assistantMessageId: msgId,
        conversationId: setup.conversation.id,
        inputTokens: 100,
        outputTokens: 50,
        groupBillingContext: { memberId },
      });

      expect(result.usageRecordId).toBeDefined();

      // Verify group spending was updated
      const [spending] = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toBeDefined();
      expect(Number(spending!.totalSpent)).toBeGreaterThan(0);

      // Clean up conversation members and spending
      await db
        .delete(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      await db.delete(memberBudgets).where(eq(memberBudgets.memberId, memberId));
      await db.delete(conversationMembers).where(eq(conversationMembers.id, memberId));
    });
  });

  describe('updateForkTip', () => {
    it('updates the tip message ID for a fork', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Insert a message to use as tip
      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'Tip message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 0,
        senderType: 'user',
        senderId: setup.user.id,
        parentMessageId: null,
      });

      // Create a fork
      const forkData = conversationForkFactory.build({
        conversationId: setup.conversation.id,
        name: 'Main',
        tipMessageId: msgId,
      });
      const [fork] = await db.insert(conversationForks).values(forkData).returning();
      if (!fork) throw new Error('Failed to create test fork');

      // Insert a new message to be the new tip
      const newTipId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: newTipId,
        conversationId: setup.conversation.id,
        content: 'New tip message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'ai',
        modelName: 'test-model',
        parentMessageId: msgId,
      });

      await updateForkTip(db, fork.id, newTipId);

      const [updatedFork] = await db
        .select()
        .from(conversationForks)
        .where(eq(conversationForks.id, fork.id));

      expect(updatedFork).toBeDefined();
      expect(updatedFork!.tipMessageId).toBe(newTipId);
    });

    it('is a no-op when fork does not exist', async () => {
      // updateForkTip uses a WHERE clause — non-matching ID updates zero rows
      await expect(
        updateForkTip(db, 'nonexistent-fork-id', 'some-msg-id')
      ).resolves.toBeUndefined();
    });
  });

  describe('resolveParentMessageId', () => {
    it('returns null when conversation has no messages', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await resolveParentMessageId(db, setup.conversation.id);

      expect(result).toBeNull();
    });

    it('returns the latest message ID by sequence number when no forkId', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1Id = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msg1Id,
        conversationId: setup.conversation.id,
        content: 'User message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'user',
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const msg2Id = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msg2Id,
        conversationId: setup.conversation.id,
        content: 'AI response',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 2,
        senderType: 'ai',
        modelName: 'test-model',
        parentMessageId: msg1Id,
      });

      const result = await resolveParentMessageId(db, setup.conversation.id);

      expect(result).toBe(msg2Id);
    });

    it('returns the fork tipMessageId when forkId is provided', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msgId = crypto.randomUUID();
      await insertEncryptedMessage(db, {
        id: msgId,
        conversationId: setup.conversation.id,
        content: 'Tip message',
        epochPublicKey: setup.epoch.epochPublicKey,
        epochNumber: 1,
        sequenceNumber: 1,
        senderType: 'ai',
        modelName: 'test-model',
        parentMessageId: null,
      });

      const forkData = conversationForkFactory.build({
        conversationId: setup.conversation.id,
        name: 'Fork 1',
        tipMessageId: msgId,
      });
      const [fork] = await db.insert(conversationForks).values(forkData).returning();
      if (!fork) throw new Error('Failed to create test fork');

      const result = await resolveParentMessageId(db, setup.conversation.id, fork.id);

      expect(result).toBe(msgId);
    });

    it('returns null when forkId is provided but fork has null tipMessageId', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const forkData = conversationForkFactory.build({
        conversationId: setup.conversation.id,
        name: 'Empty Fork',
        tipMessageId: null,
      });
      const [fork] = await db.insert(conversationForks).values(forkData).returning();
      if (!fork) throw new Error('Failed to create test fork');

      const result = await resolveParentMessageId(db, setup.conversation.id, fork.id);

      expect(result).toBeNull();
    });
  });
});
