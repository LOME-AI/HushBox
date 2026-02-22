import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { createOpenRouterClient, fetchZdrModelIds, type EvidenceConfig } from './openrouter.js';
import { createFastMockOpenRouterClient } from '../../test-helpers/openrouter-mocks.js';
import type { OpenRouterClient, ModelInfo } from './types.js';
import { fetchModels } from './openrouter.js';

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
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'anthropic/claude-3-sonnet',
    name: 'Claude 3 Sonnet',
    description: 'Anthropic Claude 3 Sonnet',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature'],
    created: Date.now(),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: FALLBACK_MODEL,
    name: 'Llama 3.1 8B Instruct',
    description: 'Meta Llama 3.1 8B',
    context_length: 131_072,
    pricing: { prompt: '0.0000001', completion: '0.0000001' },
    supported_parameters: ['temperature'],
    created: Date.now(),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

describe('OpenRouter Integration', () => {
  let client: OpenRouterClient;
  let testModel: string = FALLBACK_MODEL;
  let db: Database | null = null;
  let evidenceConfig: EvidenceConfig | undefined;

  beforeAll(async () => {
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
 * ZDR (Zero Data Retention) endpoint tests.
 *
 * fetchZdrModelIds() and fetchModels() hit public endpoints (no auth required).
 * Local dev: uses MOCK_MODELS to avoid flaky network calls.
 * CI: makes real HTTP calls to verify endpoint availability.
 */
describe('ZDR Endpoints (public, no auth)', () => {
  let zdrIds: Set<string>;
  let models: ModelInfo[];

  beforeAll(async () => {
    if (env.isLocalDev) {
      zdrIds = new Set(MOCK_MODELS.map((m) => m.id));
      models = MOCK_MODELS as ModelInfo[];
      return;
    }

    // CI: real network calls
    [zdrIds, models] = await Promise.all([fetchZdrModelIds(), fetchModels()]);
  }, 30_000);

  it('fetches ZDR endpoint list', () => {
    expect(zdrIds.size).toBeGreaterThan(0);
    // IDs follow the provider/model format
    for (const id of zdrIds) {
      expect(id).toContain('/');
    }
  });

  it('ZDR model set overlaps with available models', () => {
    const modelIds = new Set(models.map((m) => m.id));
    let overlap = 0;
    for (const id of zdrIds) {
      if (modelIds.has(id)) {
        overlap++;
      }
    }

    // At least some ZDR models should appear in the full model list
    expect(overlap).toBeGreaterThan(0);
  });
});

// Free Allowance Billing tests were removed in Phase 4 schema migration.
// The old tests referenced deleted tables (balanceTransactions) and columns
// (users.balance, users.freeAllowanceCents). The billing flow is now covered by:
// - apps/api/src/services/billing/transaction-writer.test.ts (chargeForUsage, creditUserBalance)
// - apps/api/src/services/billing/balance.test.ts (checkUserBalance with wallets)
// - apps/api/src/routes/webhooks.test.ts (processWebhookCredit end-to-end)
