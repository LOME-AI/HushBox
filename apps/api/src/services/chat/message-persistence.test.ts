import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  balanceTransactions,
  messages,
  conversations,
  type Database,
} from '@lome-chat/db';
import { userFactory, conversationFactory } from '@lome-chat/db/factories';
import { saveMessageWithBilling } from './message-persistence.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('saveMessageWithBilling', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    // Clean up in reverse order of dependencies
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
      createdMessageIds.length = 0;
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
      createdConversationIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  async function createTestUser(balance: string) {
    const userData = userFactory.build({ balance });
    const result = await db.insert(users).values(userData).returning();
    const user = result[0];
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  async function createTestConversation(userId: string) {
    const convData = conversationFactory.build({ userId });
    const result = await db.insert(conversations).values(convData).returning();
    const conversation = result[0];
    if (!conversation) throw new Error('Failed to create test conversation');
    createdConversationIds.push(conversation.id);
    return conversation;
  }

  describe('atomic message + billing', () => {
    it('inserts message with cost in single transaction', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Hello from AI!',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.001_36, // Pre-calculated cost
        inputCharacters: 500,
        outputCharacters: 200,
      });

      // Message exists with cost set
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!msg) throw new Error('Message not found');
      expect(msg.content).toBe('Hello from AI!');
      expect(msg.cost).toBeDefined();
      if (!msg.cost) throw new Error('Cost not found');
      expect(Number.parseFloat(msg.cost)).toBeCloseTo(0.001_36, 5);
      expect(result.totalCharge).toBeCloseTo(0.001_36, 5);
    });

    it('deducts cost from user balance', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.001,
        inputCharacters: 100,
        outputCharacters: 50,
      });

      const [updatedUser] = await db.select().from(users).where(eq(users.id, user.id));
      if (!updatedUser) throw new Error('User not found');
      expect(Number.parseFloat(updatedUser.balance)).toBeCloseTo(10 - 0.001, 5);
      expect(Number.parseFloat(result.newBalance)).toBeCloseTo(10 - 0.001, 5);
    });

    it('creates balance transaction', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'anthropic/claude-3-opus',
        userId: user.id,
        totalCost: 0.05,
        inputCharacters: 1000,
        outputCharacters: 500,
      });

      const [tx] = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.id, result.transactionId));
      if (!tx) throw new Error('Transaction not found');
      expect(tx.type).toBe('usage');
      expect(Number.parseFloat(tx.amount)).toBeLessThan(0);
      expect(tx.userId).toBe(user.id);
      expect(tx.model).toBe('anthropic/claude-3-opus');
      expect(tx.inputCharacters).toBe(1000);
      expect(tx.outputCharacters).toBe(500);
    });

    it('links message to balance transaction', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.001,
        inputCharacters: 100,
        outputCharacters: 50,
      });

      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!msg) throw new Error('Message not found');
      expect(msg.balanceTransactionId).toBe(result.transactionId);
    });
  });

  describe('transaction rollback', () => {
    it('rolls back message if balance update fails', async () => {
      // Create user with no ID in DB to simulate failure
      const messageId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const fakeUserId = crypto.randomUUID();

      await expect(
        saveMessageWithBilling(db, {
          messageId,
          conversationId,
          content: 'Should not exist',
          model: 'openai/gpt-4o-mini',
          userId: fakeUserId, // Non-existent user
          totalCost: 0.001,
          inputCharacters: 100,
          outputCharacters: 50,
        })
      ).rejects.toThrow();

      // Message should not exist after rollback
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      expect(msg).toBeUndefined();
    });

    it('fails on duplicate message ID (idempotency)', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      // First insert succeeds
      await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'First response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.001,
        inputCharacters: 100,
        outputCharacters: 50,
      });

      // Second insert with same ID fails
      await expect(
        saveMessageWithBilling(db, {
          messageId, // Same ID
          conversationId: conversation.id,
          content: 'Duplicate attempt',
          model: 'openai/gpt-4o-mini',
          userId: user.id,
          totalCost: 0.001,
          inputCharacters: 100,
          outputCharacters: 50,
        })
      ).rejects.toThrow();

      // Original message unchanged
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!msg) throw new Error('Message not found');
      expect(msg.content).toBe('First response');
    });
  });

  describe('negative balance handling', () => {
    it('allows balance to go negative', async () => {
      const user = await createTestUser('0.00010000'); // Very small balance
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Expensive response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.05, // More than balance
        inputCharacters: 1000,
        outputCharacters: 500,
      });

      expect(Number.parseFloat(result.newBalance)).toBeLessThan(0);

      // Message still saved
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      expect(msg).toBeDefined();
    });
  });

  describe('deductionSource', () => {
    it('deducts from balance by default', async () => {
      const user = await createTestUser('10.00000000');
      // Set free allowance
      await db
        .update(users)
        .set({ freeAllowanceCents: '500.00000000' }) // $5.00
        .where(eq(users.id, user.id));

      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.01,
        inputCharacters: 100,
        outputCharacters: 50,
        // No deductionSource - should default to 'balance'
      });

      const [updatedUser] = await db.select().from(users).where(eq(users.id, user.id));
      if (!updatedUser) throw new Error('User not found');
      expect(Number.parseFloat(updatedUser.balance)).toBeCloseTo(10 - 0.01, 5);
      expect(updatedUser.freeAllowanceCents).toBe('500.00000000'); // Unchanged
    });

    it('deducts from freeAllowance when specified', async () => {
      const user = await createTestUser('10.00000000');
      // Set free allowance
      await db
        .update(users)
        .set({ freeAllowanceCents: '500.00000000' }) // $5.00 = 500 cents
        .where(eq(users.id, user.id));

      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.01, // 1 cent
        inputCharacters: 100,
        outputCharacters: 50,
        deductionSource: 'freeAllowance',
      });

      const [updatedUser] = await db.select().from(users).where(eq(users.id, user.id));
      if (!updatedUser) throw new Error('User not found');
      expect(Number.parseFloat(updatedUser.balance)).toBe(10); // Unchanged
      expect(Number.parseFloat(updatedUser.freeAllowanceCents)).toBeCloseTo(499, 5); // Reduced by 1 cent
    });

    it('stores deductionSource in transaction', async () => {
      const user = await createTestUser('10.00000000');
      await db
        .update(users)
        .set({ freeAllowanceCents: '500.00000000' })
        .where(eq(users.id, user.id));

      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.02,
        inputCharacters: 100,
        outputCharacters: 50,
        deductionSource: 'freeAllowance',
      });

      const [tx] = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.id, result.transactionId));
      if (!tx) throw new Error('Transaction not found');
      expect(tx.deductionSource).toBe('freeAllowance');
    });
  });

  describe('edge cases', () => {
    it('handles zero cost', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Free response',
        model: 'meta/llama-3-8b',
        userId: user.id,
        totalCost: 0,
        inputCharacters: 50,
        outputCharacters: 20,
      });

      expect(result.totalCharge).toBe(0);

      // Message saved even with zero cost
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!msg) throw new Error('Message not found');
      expect(msg.cost).toBe('0.00000000');
    });

    it('stores character counts in transaction', async () => {
      const user = await createTestUser('10.00000000');
      const conversation = await createTestConversation(user.id);
      const messageId = crypto.randomUUID();
      createdMessageIds.push(messageId);

      const result = await saveMessageWithBilling(db, {
        messageId,
        conversationId: conversation.id,
        content: 'Test response',
        model: 'openai/gpt-4o-mini',
        userId: user.id,
        totalCost: 0.001,
        inputCharacters: 500,
        outputCharacters: 200,
      });

      const [tx] = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.id, result.transactionId));
      if (!tx) throw new Error('Transaction not found');
      expect(tx.inputCharacters).toBe(500);
      expect(tx.outputCharacters).toBe(200);
    });
  });
});
