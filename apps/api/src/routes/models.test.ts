import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Hono } from 'hono';
import type { Model, ModelsListResponse } from '@lome-chat/shared';
import { createModelsRoutes } from './models.js';
import { clearModelCache } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';

interface MockOpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters: string[];
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

const now = Date.now();
const sixMonthsAgo = Math.floor((now - 180 * 24 * 60 * 60 * 1000) / 1000);

const MOCK_MODELS: MockOpenRouterModel[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Most capable GPT-4 model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature', 'max_tokens', 'tools'],
    created: sixMonthsAgo, // Recent
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Balanced Claude model',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature', 'max_tokens'],
    created: sixMonthsAgo, // Recent
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/models', createModelsRoutes());
  return app;
}

describe('Models Routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearModelCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearModelCache();
  });

  describe('GET /models', () => {
    it('returns list of available models in transformed format', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models).toHaveLength(2);
      const firstModel = data.models[0];
      expect(firstModel).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'OpenAI',
        contextLength: 128_000,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
      });
    });

    it('returns models with all required fields', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      const model = data.models[0];

      // Check transformed Model format
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('description');
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('contextLength');
      expect(model).toHaveProperty('pricePerInputToken');
      expect(model).toHaveProperty('pricePerOutputToken');
      expect(model).toHaveProperty('capabilities');
      expect(model).toHaveProperty('supportedParameters');
      expect(data).toHaveProperty('premiumModelIds');
      expect(Array.isArray(data.premiumModelIds)).toBe(true);
    });

    it('derives capabilities from supported_parameters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      const gpt4 = data.models.find((m) => m.id === 'openai/gpt-4-turbo');

      // GPT-4 has 'tools' in supported_parameters, so should have 'functions' capability
      expect(gpt4?.capabilities).toContain('streaming');
      expect(gpt4?.capabilities).toContain('functions');
    });

    it('returns empty array when no models available', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data).toEqual({ models: [], premiumModelIds: [] });
    });

    it('filters out old models (older than 2 years)', async () => {
      const threeYearsAgo = Math.floor((now - 3 * 365 * 24 * 60 * 60 * 1000) / 1000);
      // Need many recent models with high context so old model isn't in top 5%
      const mockModels: MockOpenRouterModel[] = Array.from({ length: 20 }, (_, index) => ({
        id: `recent/model-${String(index)}`,
        name: `Recent Model ${String(index)}`,
        description: 'Recent model',
        context_length: 200_000,
        pricing: { prompt: '0.001', completion: '0.001' },
        supported_parameters: ['temperature'],
        created: sixMonthsAgo,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      }));
      mockModels.push({
        id: 'old/model',
        name: 'Old Model',
        description: 'Very old model',
        context_length: 50_000, // Lower context, won't be in top 5%
        pricing: { prompt: '0.001', completion: '0.001' },
        supported_parameters: ['temperature'],
        created: threeYearsAgo,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      expect(data.models.map((m) => m.id)).not.toContain('old/model');
    });

    it('returns premiumModelIds for expensive models', async () => {
      // Create 10 models with varying prices, all at same age (within 2 years)
      const oneYearAgo = Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);
      const mockModels: MockOpenRouterModel[] = Array.from({ length: 10 }, (_, index) => ({
        id: `model-${String(index)}`,
        name: `Model ${String(index)}`,
        description: 'Test model',
        context_length: 100_000,
        pricing: {
          prompt: String(0.000_01 * (index + 1)),
          completion: String(0.000_01 * (index + 1)),
        },
        supported_parameters: ['temperature'],
        created: oneYearAgo, // Within 2 years, so NOT filtered by age
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      }));

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models).toHaveLength(10);
      // Most expensive models should be premium (top 25% by price)
      expect(data.premiumModelIds).toContain('model-9');
      expect(data.premiumModelIds).toContain('model-8');
      // Cheapest should not be premium
      expect(data.premiumModelIds).not.toContain('model-0');
    });

    it('returns premiumModelIds for recently released models', async () => {
      const oneMonthAgo = Math.floor((now - 30 * 24 * 60 * 60 * 1000) / 1000);
      const eighteenMonthsAgo = Math.floor((now - 18 * 30 * 24 * 60 * 60 * 1000) / 1000);

      // Need multiple models with varying prices to establish meaningful price threshold
      const mockModels: MockOpenRouterModel[] = [
        // Cheap old model (older than 1 year) - should NOT be premium
        {
          id: 'old/cheap-model',
          name: 'Old Cheap Model',
          description: 'Old budget model',
          context_length: 100_000,
          pricing: { prompt: '0.000001', completion: '0.000001' },
          supported_parameters: ['temperature'],
          created: eighteenMonthsAgo, // 18 months ago, beyond 1 year recency
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        // Cheap new model (within 1 year) - should be premium due to recency
        {
          id: 'new/cheap-model',
          name: 'New Cheap Model',
          description: 'New budget model',
          context_length: 100_000,
          pricing: { prompt: '0.000001', completion: '0.000001' },
          supported_parameters: ['temperature'],
          created: oneMonthAgo, // Recent
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        // Add expensive models to establish price threshold
        {
          id: 'expensive/model-1',
          name: 'Expensive Model 1',
          description: 'Premium model',
          context_length: 100_000,
          pricing: { prompt: '0.0001', completion: '0.0001' },
          supported_parameters: ['temperature'],
          created: eighteenMonthsAgo,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'expensive/model-2',
          name: 'Expensive Model 2',
          description: 'Premium model',
          context_length: 100_000,
          pricing: { prompt: '0.0001', completion: '0.0001' },
          supported_parameters: ['temperature'],
          created: eighteenMonthsAgo,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockModels }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      // New model should be premium due to recency (within 1 year)
      expect(data.premiumModelIds).toContain('new/cheap-model');
      // Old cheap model should NOT be premium (old and below price threshold)
      expect(data.premiumModelIds).not.toContain('old/cheap-model');
    });
  });

  describe('GET /models/:modelId', () => {
    it('returns specific model by ID in transformed format', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const modelId = encodeURIComponent('openai/gpt-4-turbo');
      const response = await app.request(`/models/${modelId}`);

      expect(response.status).toBe(200);
      const data: Model = await response.json();
      expect(data).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'OpenAI',
        contextLength: 128_000,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
      });
    });

    it('returns 404 for unknown model', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const modelId = encodeURIComponent('unknown/model');
      const response = await app.request(`/models/${modelId}`);

      expect(response.status).toBe(404);
      const data: { error: string } = await response.json();
      expect(data).toHaveProperty('error');
    });
  });
});
