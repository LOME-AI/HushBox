import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  type Database,
  users,
  conversations,
  messages,
  balanceTransactions,
} from '@lome-chat/db';
import { userFactory, conversationFactory } from '@lome-chat/db/factories';
import { createEnvUtilities, FREE_ALLOWANCE_CENTS } from '@lome-chat/shared';
import { createOpenRouterClient, clearModelCache, type EvidenceConfig } from './openrouter.js';
import { createFastMockOpenRouterClient } from '../../test-helpers/openrouter-mocks.js';
import { saveMessageWithBilling } from '../chat/message-persistence.js';
import type { OpenRouterClient } from './types.js';

/**
 * Integration tests for OpenRouter API.
 *
 * - Local dev: Tests run with mock client (no API key needed)
 * - CI: Tests run with real API (OPENROUTER_API_KEY required)
 */

// Fallback model if dynamic selection fails
const FALLBACK_MODEL = 'meta-llama/llama-3.1-8b-instruct';

const env = createEnvUtilities({
  ...(process.env['NODE_ENV'] && { NODE_ENV: process.env['NODE_ENV'] }),
  ...(process.env['CI'] && { CI: process.env['CI'] }),
});

const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);
const DATABASE_URL = process.env['DATABASE_URL'];

// Fail fast in CI if API key is missing
if (env.isCI && !hasApiKey) {
  throw new Error(
    'OPENROUTER_API_KEY is required in CI. Ensure the secret is set in GitHub Actions.'
  );
}

if (env.isCI && !DATABASE_URL) {
  throw new Error('DATABASE_URL is required in CI for evidence recording.');
}

// Mock models for local dev testing
const MOCK_MODELS = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Latest GPT-4 model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Date.now(),
  },
  {
    id: 'anthropic/claude-3-sonnet',
    name: 'Claude 3 Sonnet',
    description: 'Anthropic Claude 3 Sonnet',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature'],
    created: Date.now(),
  },
  {
    id: FALLBACK_MODEL,
    name: 'Llama 3.1 8B Instruct',
    description: 'Meta Llama 3.1 8B',
    context_length: 131_072,
    pricing: { prompt: '0.0000001', completion: '0.0000001' },
    supported_parameters: ['temperature'],
    created: Date.now(),
  },
];

describe('OpenRouter Integration', () => {
  let client: OpenRouterClient;
  let testModel: string = FALLBACK_MODEL;
  let db: Database | null = null;
  let evidenceConfig: EvidenceConfig | undefined;

  beforeAll(async () => {
    // Clear cache to ensure fresh model list
    clearModelCache();

    if (env.isLocalDev) {
      // Local dev: use mock client
      client = createFastMockOpenRouterClient({
        streamContent: 'INTEGRATION_TEST_OK',
        models: MOCK_MODELS,
      });
      testModel = FALLBACK_MODEL;
      console.log('Using mock OpenRouter client for local development');
      return;
    }

    // CI/Production: use real client
    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required in CI/production');
    }

    // Set up database connection for evidence recording in CI
    if (DATABASE_URL) {
      db = createDb({
        connectionString: DATABASE_URL,
        neonDev: LOCAL_NEON_DEV_CONFIG,
      });
      evidenceConfig = { db, isCI: env.isCI };
    }

    client = createOpenRouterClient(apiKey, evidenceConfig);

    // Dynamically select a cheap model that's currently available
    try {
      const models = await client.listModels();

      // Find a cheap, available model (prompt pricing < $0.001 per 1k tokens)
      const cheapModels = models
        .filter((m) => {
          const promptPrice = Number.parseFloat(m.pricing.prompt);
          return !Number.isNaN(promptPrice) && promptPrice < 0.001;
        })
        .toSorted(
          (a, b) => Number.parseFloat(a.pricing.prompt) - Number.parseFloat(b.pricing.prompt)
        );

      if (cheapModels.length > 0 && cheapModels[0]) {
        testModel = cheapModels[0].id;
        console.log(`Using dynamic test model: ${testModel}`);
      } else {
        console.warn(`No cheap model found, using fallback: ${FALLBACK_MODEL}`);
      }
    } catch (error) {
      console.warn(`Failed to fetch models, using fallback: ${FALLBACK_MODEL}`, error);
    }
  });

  describe('listModels', () => {
    it('fetches real models from OpenRouter', async () => {
      const models = await client.listModels();

      expect(models.length).toBeGreaterThan(0);

      const firstModel = models[0];
      expect(firstModel).toBeDefined();
      if (firstModel) {
        expect(firstModel).toHaveProperty('id');
        expect(firstModel).toHaveProperty('name');
        expect(firstModel).toHaveProperty('context_length');
        expect(firstModel).toHaveProperty('pricing');
      }
    }, 30_000);

    it('includes popular models', async () => {
      const models = await client.listModels();

      // Should include common models
      const modelIds = models.map((m) => m.id);
      expect(modelIds.some((id) => id.includes('gpt'))).toBe(true);
      expect(modelIds.some((id) => id.includes('claude'))).toBe(true);
    }, 30_000);
  });

  describe('getModel', () => {
    it('fetches specific model by ID', async () => {
      const model = await client.getModel(testModel);

      expect(model.id).toBe(testModel);
      expect(model.name).toBeDefined();
      expect(model.context_length).toBeGreaterThan(0);
    }, 30_000);

    it('throws for unknown model', async () => {
      await expect(client.getModel('nonexistent/model-that-does-not-exist')).rejects.toThrow(
        'Model not found'
      );
    }, 30_000);
  });

  describe('chatCompletion', () => {
    it('gets response from real API', async () => {
      const response = await client.chatCompletion({
        model: testModel,
        messages: [{ role: 'user', content: 'Reply with exactly: INTEGRATION_TEST_OK' }],
        max_tokens: 50,
      });

      expect(response.id).toBeDefined();
      expect(response.model).toBeDefined();
      expect(response.choices).toHaveLength(1);

      const firstChoice = response.choices[0];
      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.role).toBe('assistant');
        expect(firstChoice.message.content).toBeDefined();
        // LLMs may not follow instructions exactly, so just check it responded
        expect(firstChoice.message.content.length).toBeGreaterThan(0);
      }

      expect(response.usage).toBeDefined();
      expect(response.usage.total_tokens).toBeGreaterThan(0);
    }, 30_000);

    it('handles system messages', async () => {
      const response = await client.chatCompletion({
        model: testModel,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say hello' },
        ],
        max_tokens: 50,
      });

      const firstChoice = response.choices[0];
      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.content.length).toBeGreaterThan(0);
      }
    }, 30_000);
  });

  describe('chatCompletionStream', () => {
    it('streams response from real API', async () => {
      const tokens: string[] = [];

      for await (const token of client.chatCompletionStream({
        model: testModel,
        messages: [{ role: 'user', content: 'Count from 1 to 3' }],
        max_tokens: 50,
      })) {
        tokens.push(token);
      }

      // Should receive multiple tokens
      expect(tokens.length).toBeGreaterThan(0);

      // Combined tokens should form a coherent response
      const fullResponse = tokens.join('');
      expect(fullResponse.length).toBeGreaterThan(0);
    }, 30_000);

    it('streams tokens incrementally', async () => {
      const tokenTimestamps: number[] = [];

      // eslint-disable-next-line sonarjs/no-unused-vars -- measuring timing, not content
      for await (const _ of client.chatCompletionStream({
        model: testModel,
        messages: [{ role: 'user', content: 'Write a short sentence' }],
        max_tokens: 30,
      })) {
        tokenTimestamps.push(Date.now());
      }

      // Should receive multiple tokens over time (not all at once)
      expect(tokenTimestamps.length).toBeGreaterThan(1);
    }, 30_000);
  });
});

/**
 * Free allowance billing integration tests.
 * These tests verify the complete billing flow for free-tier users.
 *
 * Requires DATABASE_URL for database operations.
 */
describe('Free Allowance Billing', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];
  const createdTransactionIds: string[] = [];

  beforeAll(() => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL required for billing integration tests');
    }
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    // Clean up in reverse order of dependencies
    if (createdTransactionIds.length > 0) {
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.id, createdTransactionIds));
    }
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  });

  it('deducts from freeAllowance when free-tier user sends message', async () => {
    // 1. Create a free-tier user (balance=0, freeAllowance=5 cents)
    const initialFreeAllowance = FREE_ALLOWANCE_CENTS; // "5.00000000"
    const [user] = await db
      .insert(users)
      .values(
        userFactory.build({
          balance: '0.00000000',
          freeAllowanceCents: initialFreeAllowance,
        })
      )
      .returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);

    // 2. Create a conversation
    const [conversation] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (!conversation) throw new Error('Failed to create test conversation');
    createdConversationIds.push(conversation.id);

    // 3. Save a message with billing (deduct from free allowance)
    const messageId = crypto.randomUUID();
    createdMessageIds.push(messageId);
    const costCents = 0.01; // 0.01 cents (fractional cost to test numeric precision)

    const result = await saveMessageWithBilling(db, {
      messageId,
      conversationId: conversation.id,
      content: 'Test AI response',
      model: 'openai/gpt-4o-mini',
      userId: user.id,
      totalCost: costCents / 100, // Convert to dollars for the function
      inputCharacters: 100,
      outputCharacters: 50,
      deductionSource: 'freeAllowance',
    });
    createdTransactionIds.push(result.transactionId);

    // 4. Verify the free allowance was decremented
    const [updatedUser] = await db.select().from(users).where(eq(users.id, user.id));
    if (!updatedUser) throw new Error('User not found after update');

    const initialCents = Number.parseFloat(initialFreeAllowance);
    const updatedCents = Number.parseFloat(updatedUser.freeAllowanceCents);
    const expectedCents = initialCents - costCents;

    expect(updatedCents).toBeCloseTo(expectedCents, 6);

    // 5. Verify transaction was recorded with correct deductionSource
    const [tx] = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.id, result.transactionId));
    if (!tx) throw new Error('Transaction not found');

    expect(tx.deductionSource).toBe('freeAllowance');
    expect(tx.type).toBe('usage');
  }, 30_000);

  it('stores fractional freeAllowance deductions with precision', async () => {
    // This test verifies that very small costs (< 1 cent) are tracked accurately
    const initialFreeAllowance = FREE_ALLOWANCE_CENTS;
    const [user] = await db
      .insert(users)
      .values(
        userFactory.build({
          balance: '0.00000000',
          freeAllowanceCents: initialFreeAllowance,
        })
      )
      .returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);

    const [conversation] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (!conversation) throw new Error('Failed to create test conversation');
    createdConversationIds.push(conversation.id);

    // Small fractional cost: 0.001_234_56 cents (a tiny API call)
    const fractionalCostCents = 0.001_234_56;
    const messageId = crypto.randomUUID();
    createdMessageIds.push(messageId);

    const result = await saveMessageWithBilling(db, {
      messageId,
      conversationId: conversation.id,
      content: 'Test response',
      model: 'openai/gpt-4o-mini',
      userId: user.id,
      totalCost: fractionalCostCents / 100, // Convert to dollars
      inputCharacters: 10,
      outputCharacters: 5,
      deductionSource: 'freeAllowance',
    });
    createdTransactionIds.push(result.transactionId);

    // Verify fractional precision is maintained
    const [updatedUser] = await db.select().from(users).where(eq(users.id, user.id));
    if (!updatedUser) throw new Error('User not found after update');

    const initialCents = Number.parseFloat(initialFreeAllowance);
    const updatedCents = Number.parseFloat(updatedUser.freeAllowanceCents);
    const expectedCents = initialCents - fractionalCostCents;

    // Should maintain precision to at least 6 decimal places
    expect(updatedCents).toBeCloseTo(expectedCents, 6);
  }, 30_000);
});
