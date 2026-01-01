import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Hono } from 'hono';
import { createModelsRoutes } from './models.js';
import { clearModelCache } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';

interface MockModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters: string[];
  created: number;
}

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

const MOCK_MODELS: MockModel[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Most capable GPT-4 model',
    context_length: 128000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature', 'max_tokens'],
    created: 1704067200, // 2024-01-01
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Balanced Claude model',
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature', 'max_tokens'],
    created: 1719792000, // 2024-07-01
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
    clearModelCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearModelCache();
  });

  describe('GET /models', () => {
    it('returns list of available models', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for typecheck
      const data = (await response.json()) as MockModel[];
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
      });
    });

    it('returns models with all required fields', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for typecheck
      const data = (await response.json()) as MockModel[];
      const model = data[0];

      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('description');
      expect(model).toHaveProperty('context_length');
      expect(model).toHaveProperty('pricing');
      expect(model?.pricing).toHaveProperty('prompt');
      expect(model?.pricing).toHaveProperty('completion');
      expect(model).toHaveProperty('created');
    });

    it('returns empty array when no models available', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual([]);
    });
  });

  describe('GET /models/:modelId', () => {
    it('returns specific model by ID', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: MOCK_MODELS }),
      });

      const app = createTestApp();
      const modelId = encodeURIComponent('openai/gpt-4-turbo');
      const response = await app.request(`/models/${modelId}`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
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
      const data = await response.json();
      expect(data).toHaveProperty('error');
    });
  });
});
