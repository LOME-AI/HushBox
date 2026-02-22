import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPaidTestModel, clearTestModelCache } from './test-utilities.js';
import type { OpenRouterClient, ModelInfo } from './types.js';

vi.mock('./openrouter.js', () => ({
  fetchZdrModelIds: vi.fn(),
}));

import { fetchZdrModelIds } from './openrouter.js';

const mockFetchZdrModelIds = vi.mocked(fetchZdrModelIds);

function makeModel(id: string, promptPrice: string, completionPrice: string): ModelInfo {
  return {
    id,
    name: id,
    description: `Model ${id}`,
    context_length: 4096,
    pricing: { prompt: promptPrice, completion: completionPrice },
    supported_parameters: [],
    created: Date.now(),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  };
}

function createMockClientWithModels(models: ModelInfo[]): OpenRouterClient {
  return {
    isMock: true,
    chatCompletion: vi.fn(),
    chatCompletionStream: vi.fn() as unknown as OpenRouterClient['chatCompletionStream'],
    chatCompletionStreamWithMetadata:
      vi.fn() as unknown as OpenRouterClient['chatCompletionStreamWithMetadata'],
    getModel: vi.fn(),
    getGenerationStats: vi.fn(),
    listModels: vi.fn().mockResolvedValue(models),
  };
}

describe('getPaidTestModel', () => {
  beforeEach(() => {
    clearTestModelCache();
    // Default: all models are ZDR-compatible
    mockFetchZdrModelIds.mockResolvedValue(
      new Set([
        'free/model',
        'cheap/paid-model',
        'expensive/model',
        'paid/model',
        'no-prompt/model',
        'valid/model',
      ])
    );
  });

  afterEach(() => {
    clearTestModelCache();
  });

  it('returns a paid model when available', async () => {
    const models = [
      makeModel('free/model', '0', '0'),
      makeModel('cheap/paid-model', '0.000001', '0.000001'),
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('cheap/paid-model');
  });

  it('returns fallback model when no cheap paid model found', async () => {
    const models = [makeModel('free/model', '0', '0'), makeModel('expensive/model', '0.1', '0.1')];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('openai/gpt-4o-mini');
  });

  it('caches the result across calls', async () => {
    const models = [makeModel('paid/model', '0.000001', '0.000001')];

    const listModelsMock = vi.fn().mockResolvedValue(models);
    const client: OpenRouterClient = {
      isMock: true,
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn() as unknown as OpenRouterClient['chatCompletionStream'],
      chatCompletionStreamWithMetadata:
        vi.fn() as unknown as OpenRouterClient['chatCompletionStreamWithMetadata'],
      getModel: vi.fn(),
      getGenerationStats: vi.fn(),
      listModels: listModelsMock,
    };

    await getPaidTestModel(client);
    await getPaidTestModel(client);

    expect(listModelsMock).toHaveBeenCalledTimes(1);
  });

  it('excludes models without prompts from matching', async () => {
    const models = [
      makeModel('no-prompt/model', '-1', '0.000001'),
      makeModel('valid/model', '0.000001', '0.000001'),
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('valid/model');
  });

  it('excludes models that are not ZDR-compatible', async () => {
    mockFetchZdrModelIds.mockResolvedValue(new Set(['zdr-ok/model']));

    const models = [
      makeModel('no-zdr/cheap-model', '0.000001', '0.000001'),
      makeModel('zdr-ok/model', '0.000005', '0.000005'),
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('zdr-ok/model');
  });

  it('returns fallback when all cheap models lack ZDR support', async () => {
    mockFetchZdrModelIds.mockResolvedValue(new Set());

    const models = [
      makeModel('no-zdr/model-a', '0.000001', '0.000001'),
      makeModel('no-zdr/model-b', '0.000002', '0.000002'),
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('openai/gpt-4o-mini');
  });
});
