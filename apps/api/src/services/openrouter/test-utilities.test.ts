import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPaidTestModel, clearTestModelCache } from './test-utilities.js';
import type { OpenRouterClient, ModelInfo } from './types.js';

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
  });

  afterEach(() => {
    clearTestModelCache();
  });

  it('returns a paid model when available', async () => {
    const models: ModelInfo[] = [
      {
        id: 'free/model',
        name: 'Free Model',
        description: 'A free model',
        context_length: 4096,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: [],
        created: Date.now(),
      },
      {
        id: 'cheap/paid-model',
        name: 'Cheap Paid Model',
        description: 'A very cheap paid model',
        context_length: 4096,
        pricing: { prompt: '0.000001', completion: '0.000001' },
        supported_parameters: [],
        created: Date.now(),
      },
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('cheap/paid-model');
  });

  it('returns fallback model when no cheap paid model found', async () => {
    const models: ModelInfo[] = [
      {
        id: 'free/model',
        name: 'Free Model',
        description: 'A free model',
        context_length: 4096,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: [],
        created: Date.now(),
      },
      {
        id: 'expensive/model',
        name: 'Expensive Model',
        description: 'An expensive model',
        context_length: 4096,
        pricing: { prompt: '0.1', completion: '0.1' },
        supported_parameters: [],
        created: Date.now(),
      },
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('openai/gpt-4o-mini');
  });

  it('caches the result across calls', async () => {
    const models: ModelInfo[] = [
      {
        id: 'paid/model',
        name: 'Paid Model',
        description: 'A paid model',
        context_length: 4096,
        pricing: { prompt: '0.000001', completion: '0.000001' },
        supported_parameters: [],
        created: Date.now(),
      },
    ];

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
    const models: ModelInfo[] = [
      {
        id: 'no-prompt/model',
        name: 'No Prompt Model',
        description: 'A model that only does completions',
        context_length: 4096,
        pricing: { prompt: '-1', completion: '0.000001' },
        supported_parameters: [],
        created: Date.now(),
      },
      {
        id: 'valid/model',
        name: 'Valid Model',
        description: 'A valid model',
        context_length: 4096,
        pricing: { prompt: '0.000001', completion: '0.000001' },
        supported_parameters: [],
        created: Date.now(),
      },
    ];

    const client = createMockClientWithModels(models);
    const result = await getPaidTestModel(client);

    expect(result).toBe('valid/model');
  });
});
