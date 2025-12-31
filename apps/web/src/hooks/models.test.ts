import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { Model } from '@lome-chat/shared';
import { useModels, transformApiModel, isExcludedModel } from './models.js';

// Mock the api module
vi.mock('../lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../lib/api.js';

const mockedApi = vi.mocked(api);

// Base model for testing
const BASE_MODEL = {
  id: 'openai/gpt-4-turbo',
  name: 'GPT-4 Turbo',
  description: 'Most capable GPT-4 model',
  context_length: 128000,
  pricing: { prompt: '0.00001', completion: '0.00003' },
  supported_parameters: ['temperature', 'tools', 'tool_choice'],
};

// Backend API response format (OpenRouter format)
const MOCK_API_RESPONSE = [
  BASE_MODEL,
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Balanced Claude model',
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature', 'max_tokens'],
  },
];

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('transformApiModel', () => {
  it('transforms API model to frontend format', () => {
    const apiModel = {
      id: 'openai/gpt-4-turbo',
      name: 'GPT-4 Turbo',
      description: 'Test model',
      context_length: 128000,
      pricing: { prompt: '0.00001', completion: '0.00003' },
      supported_parameters: ['temperature', 'tools', 'tool_choice'],
    };

    const result = transformApiModel(apiModel);

    expect(result.id).toBe('openai/gpt-4-turbo');
    expect(result.name).toBe('GPT-4 Turbo');
    expect(result.provider).toBe('OpenAI');
    expect(result.contextLength).toBe(128000);
    expect(result.pricePerInputToken).toBe(0.00001);
    expect(result.pricePerOutputToken).toBe(0.00003);
    expect(result.description).toBe('Test model');
    expect(result.supportedParameters).toEqual(['temperature', 'tools', 'tool_choice']);
  });

  it('extracts provider from model ID', () => {
    expect(transformApiModel({ ...BASE_MODEL, id: 'openai/gpt-4' }).provider).toBe('OpenAI');
    expect(transformApiModel({ ...BASE_MODEL, id: 'anthropic/claude' }).provider).toBe('Anthropic');
    expect(transformApiModel({ ...BASE_MODEL, id: 'google/gemini' }).provider).toBe('Google');
    expect(transformApiModel({ ...BASE_MODEL, id: 'meta-llama/llama-3' }).provider).toBe('Meta');
    expect(transformApiModel({ ...BASE_MODEL, id: 'deepseek/deepseek-r1' }).provider).toBe(
      'DeepSeek'
    );
    expect(transformApiModel({ ...BASE_MODEL, id: 'unknown/model' }).provider).toBe('Unknown');
  });

  it('extracts provider from model name format "Provider: Model Name"', () => {
    const result = transformApiModel({
      ...BASE_MODEL,
      id: 'someunknown/model',
      name: 'Acme Corp: Super Model',
    });
    expect(result.provider).toBe('Acme Corp');
    expect(result.name).toBe('Super Model');
  });

  it('removes provider prefix from displayed name', () => {
    const result = transformApiModel({
      ...BASE_MODEL,
      id: 'openai/gpt-4',
      name: 'OpenAI: GPT-4 Turbo',
    });
    expect(result.name).toBe('GPT-4 Turbo');
    expect(result.provider).toBe('OpenAI');
  });

  it('keeps name as-is when no colon format', () => {
    const result = transformApiModel({
      ...BASE_MODEL,
      id: 'openai/gpt-4',
      name: 'GPT-4 Turbo',
    });
    expect(result.name).toBe('GPT-4 Turbo');
    expect(result.provider).toBe('OpenAI');
  });

  it('derives capabilities from supported_parameters', () => {
    const withTools = transformApiModel({
      ...BASE_MODEL,
      supported_parameters: ['tools', 'tool_choice'],
    });
    expect(withTools.capabilities).toContain('functions');

    const withJsonMode = transformApiModel({
      ...BASE_MODEL,
      supported_parameters: ['response_format'],
    });
    expect(withJsonMode.capabilities).toContain('json-mode');

    const basic = transformApiModel({
      ...BASE_MODEL,
      supported_parameters: ['temperature'],
    });
    expect(basic.capabilities).toContain('streaming');
    expect(basic.capabilities).not.toContain('functions');
  });
});

describe('useModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and transforms models', async () => {
    mockedApi.get.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method doesn't rely on this
    expect(mockedApi.get).toHaveBeenCalledWith('/models');
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0]).toMatchObject({
      id: 'openai/gpt-4-turbo',
      provider: 'OpenAI',
      contextLength: 128000,
    });
  });

  it('handles API errors', async () => {
    mockedApi.get.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Network error');
  });

  it('returns empty array when API returns empty', async () => {
    mockedApi.get.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([]);
  });

  it('filters out free models', async () => {
    const apiModels = [
      { ...BASE_MODEL, id: 'paid/model', pricing: { prompt: '0.00001', completion: '0.00001' } },
      { ...BASE_MODEL, id: 'free/model', pricing: { prompt: '0', completion: '0' } },
    ];
    mockedApi.get.mockResolvedValueOnce(apiModels);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('paid/model');
  });

  it('filters out Body Builder models', async () => {
    const apiModels = [
      BASE_MODEL,
      { ...BASE_MODEL, id: 'openrouter/body-builder', name: 'Body Builder (beta)' },
    ];
    mockedApi.get.mockResolvedValueOnce(apiModels);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('openai/gpt-4-turbo');
  });

  it('filters out Auto Router models', async () => {
    const apiModels = [BASE_MODEL, { ...BASE_MODEL, id: 'openrouter/auto', name: 'Auto Router' }];
    mockedApi.get.mockResolvedValueOnce(apiModels);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('openai/gpt-4-turbo');
  });
});

describe('isExcludedModel', () => {
  const baseModel: Model = {
    id: 'test/model',
    name: 'Test Model',
    description: 'Test',
    provider: 'Test',
    contextLength: 1000,
    pricePerInputToken: 0.001,
    pricePerOutputToken: 0.001,
    capabilities: [],
    supportedParameters: [],
  };

  it('excludes free models (both input and output price = 0)', () => {
    const freeModel = { ...baseModel, pricePerInputToken: 0, pricePerOutputToken: 0 };
    expect(isExcludedModel(freeModel)).toBe(true);
  });

  it('includes models with non-zero input price', () => {
    const paidModel = { ...baseModel, pricePerInputToken: 0.001, pricePerOutputToken: 0 };
    expect(isExcludedModel(paidModel)).toBe(false);
  });

  it('includes models with non-zero output price', () => {
    const paidModel = { ...baseModel, pricePerInputToken: 0, pricePerOutputToken: 0.001 };
    expect(isExcludedModel(paidModel)).toBe(false);
  });

  it('excludes Body Builder models (case insensitive)', () => {
    expect(isExcludedModel({ ...baseModel, name: 'Body Builder (beta)' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'body builder' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'BODY BUILDER' })).toBe(true);
  });

  it('excludes Auto Router models (case insensitive)', () => {
    expect(isExcludedModel({ ...baseModel, name: 'Auto Router' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'auto router' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'AUTO ROUTER' })).toBe(true);
  });

  it('excludes models with "image" in name (case insensitive)', () => {
    expect(isExcludedModel({ ...baseModel, name: 'DALL-E 3 Image Generator' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'Stable Diffusion Image' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'IMAGE Model' })).toBe(true);
    expect(isExcludedModel({ ...baseModel, name: 'image-gen-v2' })).toBe(true);
  });

  it('includes normal paid models', () => {
    expect(isExcludedModel({ ...baseModel, name: 'GPT-4 Turbo' })).toBe(false);
    expect(isExcludedModel({ ...baseModel, name: 'Claude 3.5 Sonnet' })).toBe(false);
  });
});
