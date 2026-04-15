import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@ai-sdk/gateway', () => ({
  createGateway: () => ({
    getAvailableModels: () =>
      Promise.resolve({
        models: (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__ ?? [],
      }),
  }),
}));

import { Hono } from 'hono';
import type { ModelsListResponse } from '@hushbox/shared';
import { modelsRoute } from './models.js';
import type { AppEnv } from '../types.js';
import { clearModelCache } from '@hushbox/shared/models';

interface MockGatewayModel {
  id: string;
  name: string;
  description: string;
  modelType: 'language' | 'image' | 'video' | 'embedding';
  pricing: { input: string; output: string };
}

/** Use known ZDR-compliant models so processModels() includes them. */
const MOCK_MODELS: MockGatewayModel[] = [
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    description: 'Most capable model',
    modelType: 'language',
    pricing: { input: '0.00001', output: '0.00003' },
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    description: 'Cheaper model',
    modelType: 'language',
    pricing: { input: '0.0000005', output: '0.0000015' },
  },
];

function setMockModels(models: MockGatewayModel[]): void {
  (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__ = models;
}

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.env = { AI_GATEWAY_API_KEY: 'test-key' } as AppEnv['Bindings'];
    await next();
  });
  app.route('/models', modelsRoute);
  return app;
}

describe('Models Routes', () => {
  beforeEach(() => {
    clearModelCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { __TEST_MOCK_MODELS__?: unknown[] }).__TEST_MOCK_MODELS__;
  });

  describe('GET /models', () => {
    it('returns list of available ZDR models in transformed format', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models.length).toBeGreaterThan(0);
      const firstModel = data.models.find((m) => m.id === 'openai/gpt-5');
      expect(firstModel).toBeDefined();
      expect(firstModel!.id).toBe('openai/gpt-5');
      expect(firstModel!.name).toBe('GPT-5');
    });

    it('returns models with all required fields', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      expect(data.models.length).toBeGreaterThan(0);
      const model = data.models[0]!;

      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('description');
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('contextLength');
      expect(model).toHaveProperty('pricePerInputToken');
      expect(model).toHaveProperty('pricePerOutputToken');
      expect(data).toHaveProperty('premiumModelIds');
      expect(Array.isArray(data.premiumModelIds)).toBe(true);
    });

    it('filters out non-ZDR models', async () => {
      setMockModels([
        ...MOCK_MODELS,
        {
          id: 'fake/non-zdr-model',
          name: 'Fake Non-ZDR',
          description: 'Should be filtered',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ]);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      const ids = data.models.map((m) => m.id);
      expect(ids).not.toContain('fake/non-zdr-model');
    });

    it('classifies expensive models as premium', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      // GPT-5 is more expensive than GPT-4o Mini → should be premium
      expect(data.premiumModelIds).toContain('openai/gpt-5');
    });

    it('returns empty models list when no ZDR-compliant models in response', async () => {
      setMockModels([
        {
          id: 'fake/not-zdr',
          name: 'Fake',
          description: 'Not on allow-list',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ]);

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models).toEqual([]);
    });

    it('returns 500 when AI_GATEWAY_API_KEY is missing', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = {} as AppEnv['Bindings'];
        await next();
      });
      app.route('/models', modelsRoute);

      const response = await app.request('/models');
      expect(response.status).toBe(500);
    });
  });
});
