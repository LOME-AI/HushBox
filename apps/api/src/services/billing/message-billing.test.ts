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
import { userFactory, conversationFactory, messageFactory } from '@lome-chat/db/factories';
import { billMessage } from './message-billing.js';
import type { GenerationStats } from '../openrouter/types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('billMessage', () => {
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
      // Delete balance transactions first
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  const mockGenerationStats: GenerationStats = {
    id: 'gen-123',
    native_tokens_prompt: 100,
    native_tokens_completion: 50,
    total_cost: 0.001, // $0.001 from OpenRouter
  };

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

  async function createTestMessage(conversationId: string) {
    const msgData = messageFactory.build({
      conversationId,
      role: 'assistant',
      content: 'Hello!',
    });
    const result = await db.insert(messages).values(msgData).returning();
    const message = result[0];
    if (!message) throw new Error('Failed to create test message');
    createdMessageIds.push(message.id);
    return message;
  }

  it('deducts correct amount from user balance', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    // Model cost: 0.001 * 1.15 = 0.00115
    // Storage: 700 * 0.0000003 = 0.00021
    // Total: ~0.00136
    expect(result.totalCharge).toBeCloseTo(0.00136, 5);
    expect(parseFloat(result.newBalance)).toBeLessThan(10);
  });

  it('creates balance transaction with type usage', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    const txResult = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.id, result.transactionId));
    const tx = txResult[0];
    if (!tx) throw new Error('Transaction not found');

    expect(tx).toBeDefined();
    expect(tx.type).toBe('usage');
    expect(parseFloat(tx.amount)).toBeLessThan(0);
    expect(tx.userId).toBe(user.id);
  });

  it('links message to balance transaction', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    const msgResult = await db.select().from(messages).where(eq(messages.id, message.id));
    const updatedMessage = msgResult[0];
    if (!updatedMessage) throw new Error('Message not found');

    expect(updatedMessage.balanceTransactionId).toBe(result.transactionId);
  });

  it('stores cost on message', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    const msgResult2 = await db.select().from(messages).where(eq(messages.id, message.id));
    const updatedMessage = msgResult2[0];
    if (!updatedMessage) throw new Error('Message not found');

    expect(updatedMessage.cost).toBeDefined();
    if (!updatedMessage.cost) throw new Error('Cost should be defined');
    expect(parseFloat(updatedMessage.cost)).toBeCloseTo(result.totalCharge, 5);
  });

  it('includes model name in transaction description', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'anthropic/claude-3-opus',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    const txResult2 = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.id, result.transactionId));
    const tx = txResult2[0];
    if (!tx) throw new Error('Transaction not found');

    expect(tx.description).toContain('anthropic/claude-3-opus');
    expect(tx.description).toContain('100+50 tokens');
    expect(tx.description).toContain('700 chars');
  });

  it('correctly records balance after transaction', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    const txResult3 = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.id, result.transactionId));
    const tx = txResult3[0];
    if (!tx) throw new Error('Transaction not found');

    expect(tx.balanceAfter).toBe(result.newBalance);
  });

  it('allows balance to go negative', async () => {
    const user = await createTestUser('0.00010000'); // Very small balance
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    // This should complete without error even though it will make balance negative
    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'openai/gpt-4o-mini',
      generationStats: mockGenerationStats,
      inputCharacters: 500,
      outputCharacters: 200,
    });

    expect(parseFloat(result.newBalance)).toBeLessThan(0);
  });

  it('handles zero cost from OpenRouter', async () => {
    const user = await createTestUser('10.00000000');
    const conversation = await createTestConversation(user.id);
    const message = await createTestMessage(conversation.id);

    const zeroCostStats: GenerationStats = {
      id: 'gen-free',
      native_tokens_prompt: 10,
      native_tokens_completion: 5,
      total_cost: 0, // Free model
    };

    const result = await billMessage(db, {
      userId: user.id,
      messageId: message.id,
      model: 'meta/llama-3-8b', // Free model
      generationStats: zeroCostStats,
      inputCharacters: 50,
      outputCharacters: 20,
    });

    // Only storage fee: 70 * 0.0000003 = 0.000021
    expect(result.totalCharge).toBeCloseTo(0.000021, 8);
  });
});
