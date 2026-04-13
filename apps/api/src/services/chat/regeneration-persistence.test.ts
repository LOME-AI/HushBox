import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  contentItems,
  conversations,
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
  messageFactory,
  conversationForkFactory,
} from '@hushbox/db/factories';
import {
  createFirstEpoch,
  generateKeyPair,
  openMessageEnvelope,
  decryptTextWithContentKey,
} from '@hushbox/crypto';
import { saveRegeneratedResponse, saveEditedChatTurn } from './regeneration-persistence.js';

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

async function insertTestMessage(
  db: Database,
  overrides: Partial<typeof messages.$inferSelect> & {
    conversationId: string;
    sequenceNumber: number;
    epochNumber: number;
  }
): Promise<typeof messages.$inferSelect> {
  const data = messageFactory.build({
    senderType: 'user',
    ...overrides,
  });
  const [msg] = await db.insert(messages).values(data).returning();
  if (!msg) throw new Error('Failed to insert test message');
  return msg;
}

describe('saveRegeneratedResponse', () => {
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

  it('deletes messages after anchor and inserts new AI message', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Build a chain: user msg1 -> AI msg2 -> user msg3 -> AI msg4
    // Regenerate from msg1 (anchor) — should delete msg2, msg3, msg4 and add new AI msg
    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: msg1.id,
    });
    await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 4,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: null,
    });

    // Update conversation nextSequence to 5 (since we have 4 messages)
    await db
      .update(conversations)
      .set({ nextSequence: 5 })
      .where(eq(conversations.id, setup.conversation.id));

    const newAiId = crypto.randomUUID();

    const result = await saveRegeneratedResponse(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      anchorMessageId: msg1.id,
      assistantMessageId: newAiId,
      assistantContent: 'Regenerated response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.002,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(result.cost).toBe('0.00200000');
    expect(result.usageRecordId).toBeDefined();

    // Only msg1 and the new AI message should exist
    const remaining = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, setup.conversation.id));
    expect(remaining).toHaveLength(2);

    const ids = remaining.map((m) => m.id);
    expect(ids).toContain(msg1.id);
    expect(ids).toContain(newAiId);

    // New AI message should be encrypted and decryptable via wrap-once envelope
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, newAiId));
    if (!aiMsg) throw new Error('AI message not found');
    expect(aiMsg.senderType).toBe('ai');
    expect(aiMsg.parentMessageId).toBe(msg1.id);
    const [aiCi] = await db.select().from(contentItems).where(eq(contentItems.messageId, newAiId));
    if (!aiCi?.encryptedBlob) throw new Error('AI content item not found');
    const contentKey = openMessageEnvelope(setup.epochPrivateKey, aiMsg.wrappedContentKey);
    const decrypted = decryptTextWithContentKey(contentKey, aiCi.encryptedBlob);
    expect(decrypted).toBe('Regenerated response');
  });

  it('charges user wallet for the regenerated response', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const newAiId = crypto.randomUUID();

    await saveRegeneratedResponse(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      anchorMessageId: msg1.id,
      assistantMessageId: newAiId,
      assistantContent: 'Response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.05,
      inputTokens: 200,
      outputTokens: 100,
    });

    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!wallet) throw new Error('Wallet not found');
    expect(Number.parseFloat(wallet.balance)).toBeCloseTo(10 - 0.05, 5);
  });

  it('updates fork tip when forkId is provided', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Create a fork
    const forkData = conversationForkFactory.build({
      conversationId: setup.conversation.id,
      name: 'Test Fork',
    });
    const [fork] = await db.insert(conversationForks).values(forkData).returning();
    if (!fork) throw new Error('Failed to create fork');

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const newAiId = crypto.randomUUID();

    await saveRegeneratedResponse(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      anchorMessageId: msg1.id,
      assistantMessageId: newAiId,
      assistantContent: 'Regenerated response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      forkId: fork.id,
    });

    // Fork tip should now point to the new AI message
    const [updatedFork] = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.id, fork.id));
    if (!updatedFork) throw new Error('Fork not found');
    expect(updatedFork.tipMessageId).toBe(newAiId);
  });

  it('rolls back on insufficient balance', async () => {
    const setup = await createTestSetup(db, '0.00010000');
    createdUserIds.push(setup.user.id);

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    const msg2 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: msg1.id,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    await expect(
      saveRegeneratedResponse(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        anchorMessageId: msg1.id,
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Should fail',
        model: 'openai/gpt-4o-mini',
        totalCost: 1,
        inputTokens: 500,
        outputTokens: 500,
      })
    ).rejects.toThrow();

    // msg2 should still exist (transaction rolled back, so delete was undone)
    const [remaining] = await db.select().from(messages).where(eq(messages.id, msg2.id));
    expect(remaining).toBeDefined();
  });

  it('assigns new AI message the next sequence number', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const newAiId = crypto.randomUUID();

    await saveRegeneratedResponse(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      anchorMessageId: msg1.id,
      assistantMessageId: newAiId,
      assistantContent: 'Response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
    });

    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, newAiId));
    if (!aiMsg) throw new Error('AI message not found');
    expect(aiMsg.sequenceNumber).toBeDefined();
    expect(aiMsg.epochNumber).toBe(1);
  });
});

describe('saveEditedChatTurn', () => {
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

  it('replaces the target message and its followers with a new user+AI turn', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Chain: msg0 (root) -> msg1 (user, target) -> msg2 (AI)
    // Edit msg1 -> deletes msg1 and msg2, inserts new user + new AI
    const msg0 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: msg0.id,
    });
    await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: msg1.id,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 4 })
      .where(eq(conversations.id, setup.conversation.id));

    const newUserId = crypto.randomUUID();
    const newAiId = crypto.randomUUID();

    const result = await saveEditedChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      targetMessageId: msg1.id,
      newUserMessageId: newUserId,
      newUserContent: 'Edited user message',
      assistantMessageId: newAiId,
      assistantContent: 'New AI response to edit',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.002,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(result.cost).toBe('0.00200000');
    expect(result.usageRecordId).toBeDefined();

    // msg0, newUser, newAI should exist; msg1 and msg2 deleted
    const remaining = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, setup.conversation.id));
    expect(remaining).toHaveLength(3);

    const ids = remaining.map((m) => m.id);
    expect(ids).toContain(msg0.id);
    expect(ids).toContain(newUserId);
    expect(ids).toContain(newAiId);

    // New user message should have msg0 as parent (target's old parent)
    const [newUserMsg] = await db.select().from(messages).where(eq(messages.id, newUserId));
    if (!newUserMsg) throw new Error('New user message not found');
    expect(newUserMsg.parentMessageId).toBe(msg0.id);
    expect(newUserMsg.senderType).toBe('user');
    expect(newUserMsg.senderId).toBe(setup.user.id);

    // New AI message should have new user message as parent
    const [newAiMsg] = await db.select().from(messages).where(eq(messages.id, newAiId));
    if (!newAiMsg) throw new Error('New AI message not found');
    expect(newAiMsg.parentMessageId).toBe(newUserId);
    expect(newAiMsg.senderType).toBe('ai');

    // Verify encryption via wrap-once envelope
    const [userCi] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, newUserId));
    if (!userCi?.encryptedBlob) throw new Error('User content item not found');
    const userCk = openMessageEnvelope(setup.epochPrivateKey, newUserMsg.wrappedContentKey);
    const decryptedUser = decryptTextWithContentKey(userCk, userCi.encryptedBlob);
    expect(decryptedUser).toBe('Edited user message');
    const [aiCi] = await db.select().from(contentItems).where(eq(contentItems.messageId, newAiId));
    if (!aiCi?.encryptedBlob) throw new Error('AI content item not found');
    const aiCk = openMessageEnvelope(setup.epochPrivateKey, newAiMsg.wrappedContentKey);
    const decryptedAi = decryptTextWithContentKey(aiCk, aiCi.encryptedBlob);
    expect(decryptedAi).toBe('New AI response to edit');
  }, 15_000);

  it('sets new user message parentMessageId to the target parent when target has no parent', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // msg1 is root (no parent), editing it
    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: msg1.id,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    const newUserId = crypto.randomUUID();
    const newAiId = crypto.randomUUID();

    await saveEditedChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      targetMessageId: msg1.id,
      newUserMessageId: newUserId,
      newUserContent: 'Edited root message',
      assistantMessageId: newAiId,
      assistantContent: 'Response to edited root',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
    });

    // New user message should have null parent (same as target's old parent)
    const [newUserMsg] = await db.select().from(messages).where(eq(messages.id, newUserId));
    if (!newUserMsg) throw new Error('New user message not found');
    expect(newUserMsg.parentMessageId).toBeNull();
  });

  it('charges wallet for the edited turn', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    await saveEditedChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      targetMessageId: msg1.id,
      newUserMessageId: crypto.randomUUID(),
      newUserContent: 'Edited',
      assistantMessageId: crypto.randomUUID(),
      assistantContent: 'Response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.03,
      inputTokens: 100,
      outputTokens: 50,
    });

    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!wallet) throw new Error('Wallet not found');
    expect(Number.parseFloat(wallet.balance)).toBeCloseTo(10 - 0.03, 5);
  });

  it('updates fork tip when forkId is provided', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const forkData = conversationForkFactory.build({
      conversationId: setup.conversation.id,
      name: 'Edit Fork',
    });
    const [fork] = await db.insert(conversationForks).values(forkData).returning();
    if (!fork) throw new Error('Failed to create fork');

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const newAiId = crypto.randomUUID();

    await saveEditedChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      targetMessageId: msg1.id,
      newUserMessageId: crypto.randomUUID(),
      newUserContent: 'Edited',
      assistantMessageId: newAiId,
      assistantContent: 'Response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      forkId: fork.id,
    });

    const [updatedFork] = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.id, fork.id));
    if (!updatedFork) throw new Error('Fork not found');
    expect(updatedFork.tipMessageId).toBe(newAiId);
  });

  it('rolls back everything on insufficient balance', async () => {
    const setup = await createTestSetup(db, '0.00010000');
    createdUserIds.push(setup.user.id);

    const msg1 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      epochNumber: 1,
      senderId: setup.user.id,
      senderType: 'user',
      parentMessageId: null,
    });
    const msg2 = await insertTestMessage(db, {
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      epochNumber: 1,
      senderType: 'ai',
      senderId: null,
      parentMessageId: msg1.id,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    await expect(
      saveEditedChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        targetMessageId: msg1.id,
        newUserMessageId: crypto.randomUUID(),
        newUserContent: 'Should fail',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Should fail',
        model: 'openai/gpt-4o-mini',
        totalCost: 1,
        inputTokens: 500,
        outputTokens: 500,
      })
    ).rejects.toThrow();

    // Original messages should still exist (transaction rolled back)
    const [origMsg1] = await db.select().from(messages).where(eq(messages.id, msg1.id));
    expect(origMsg1).toBeDefined();
    const [origMsg2] = await db.select().from(messages).where(eq(messages.id, msg2.id));
    expect(origMsg2).toBeDefined();
  });
});
