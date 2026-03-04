import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPaidTestModel,
  clearTestModelCache,
  retryWithBackoff,
  isProviderError,
} from './test-utilities.js';
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

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const function_ = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(function_);

    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on subsequent attempt', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = retryWithBackoff(function_);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts exhausted', async () => {
    const function_ = vi.fn().mockRejectedValue(new Error('persistent'));

    const promise = retryWithBackoff(function_, { maxAttempts: 2 });
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow('persistent');

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(function_).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff capped at maxDelayMs', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(function_, {
      maxAttempts: 4,
      initialDelayMs: 1000,
      maxDelayMs: 4000,
    });

    // First retry: 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(function_).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(function_).toHaveBeenCalledTimes(2);

    // Second retry: 2000ms
    await vi.advanceTimersByTimeAsync(1999);
    expect(function_).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(function_).toHaveBeenCalledTimes(3);

    // Third retry: capped at 4000ms (not 4000ms from 1000*2^2)
    await vi.advanceTimersByTimeAsync(3999);
    expect(function_).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(4);
  });

  it('skips retry when shouldRetry returns false', async () => {
    const function_ = vi.fn().mockRejectedValue(new Error('non-retryable'));

    await expect(
      retryWithBackoff(function_, {
        maxAttempts: 3,
        shouldRetry: () => false,
      })
    ).rejects.toThrow('non-retryable');

    expect(function_).toHaveBeenCalledTimes(1);
  });

  it('retries all errors by default', async () => {
    const function_ = vi
      .fn()
      .mockRejectedValueOnce(new Error('any error'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(function_);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(function_).toHaveBeenCalledTimes(2);
  });
});

describe('isProviderError', () => {
  it('returns true for OpenRouter error messages', () => {
    expect(isProviderError(new Error('OpenRouter error: Provider returned error'))).toBe(true);
    expect(isProviderError(new Error('OpenRouter error: rate limited'))).toBe(true);
  });

  it('returns false for non-OpenRouter errors', () => {
    expect(isProviderError(new Error('Network timeout'))).toBe(false);
    expect(isProviderError(new Error('Model not found'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isProviderError('string error')).toBe(false);
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError(void 0)).toBe(false);
  });
});
