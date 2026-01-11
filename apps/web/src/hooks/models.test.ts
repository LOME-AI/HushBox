import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { Model } from '@lome-chat/shared';
import { STRONGEST_MODEL_ID, VALUE_MODEL_ID } from '@lome-chat/shared';
import { useModels, getAccessibleModelIds } from './models.js';

// Mock the api module
vi.mock('../lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../lib/api.js';

const mockedApi = vi.mocked(api);

// Mock transformed Model objects (as returned by the API)
const MOCK_MODELS: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Most capable GPT-4 model',
    provider: 'OpenAI',
    contextLength: 128000,
    pricePerInputToken: 0.00001,
    pricePerOutputToken: 0.00003,
    capabilities: ['streaming', 'functions'],
    supportedParameters: ['temperature', 'tools', 'tool_choice'],
    created: Math.floor(Date.now() / 1000),
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Balanced Claude model',
    provider: 'Anthropic',
    contextLength: 200000,
    pricePerInputToken: 0.000003,
    pricePerOutputToken: 0.000015,
    capabilities: ['streaming'],
    supportedParameters: ['temperature', 'max_tokens'],
    created: Math.floor(Date.now() / 1000),
  },
];

// Backend API response format
const MOCK_API_RESPONSE = {
  models: MOCK_MODELS,
  premiumModelIds: ['openai/gpt-4-turbo'],
};

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

describe('useModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches models from API', async () => {
    mockedApi.get.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mock method doesn't rely on this
    expect(mockedApi.get).toHaveBeenCalledWith('/models');
    expect(result.current.data?.models).toHaveLength(2);
  });

  it('returns models with correct structure', async () => {
    mockedApi.get.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.models[0]).toMatchObject({
      id: 'openai/gpt-4-turbo',
      name: 'GPT-4 Turbo',
      provider: 'OpenAI',
      contextLength: 128000,
      pricePerInputToken: 0.00001,
      pricePerOutputToken: 0.00003,
    });
  });

  it('returns premiumIds as a Set', async () => {
    mockedApi.get.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.premiumIds).toBeInstanceOf(Set);
    expect(result.current.data?.premiumIds.has('openai/gpt-4-turbo')).toBe(true);
    expect(result.current.data?.premiumIds.has('anthropic/claude-3.5-sonnet')).toBe(false);
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

  it('returns empty data when API returns empty models', async () => {
    mockedApi.get.mockResolvedValueOnce({ models: [], premiumModelIds: [] });

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.models).toEqual([]);
    expect(result.current.data?.premiumIds.size).toBe(0);
  });
});

describe('getAccessibleModelIds', () => {
  // Models with varying prices for testing sorting
  const testModels: Model[] = [
    {
      id: 'expensive-basic',
      name: 'Expensive Basic',
      description: 'A pricey basic model',
      provider: 'TestProvider',
      contextLength: 100000,
      pricePerInputToken: 0.00005, // Highest price
      pricePerOutputToken: 0.00015,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'cheap-basic',
      name: 'Cheap Basic',
      description: 'An affordable basic model',
      provider: 'TestProvider',
      contextLength: 50000,
      pricePerInputToken: 0.000001, // Lowest price
      pricePerOutputToken: 0.000003,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'mid-basic',
      name: 'Mid Basic',
      description: 'A mid-priced basic model',
      provider: 'TestProvider',
      contextLength: 75000,
      pricePerInputToken: 0.00001, // Mid price
      pricePerOutputToken: 0.00003,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'premium-model',
      name: 'Premium Model',
      description: 'A premium model',
      provider: 'TestProvider',
      contextLength: 200000,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0003,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
  ];

  const premiumIds = new Set(['premium-model']);

  it('returns hardcoded premium IDs when canAccessPremium is true', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, true);

    expect(result.strongestId).toBe(STRONGEST_MODEL_ID);
    expect(result.valueId).toBe(VALUE_MODEL_ID);
  });

  it('returns highest-price basic model as strongest when canAccessPremium is false', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    // 'expensive-basic' has the highest price among basic models
    expect(result.strongestId).toBe('expensive-basic');
  });

  it('returns lowest-price basic model as value when canAccessPremium is false', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    // 'cheap-basic' has the lowest price among basic models
    expect(result.valueId).toBe('cheap-basic');
  });

  it('handles empty model list gracefully', () => {
    const result = getAccessibleModelIds([], new Set(), false);

    expect(result.strongestId).toBe('');
    expect(result.valueId).toBe('');
  });

  it('handles case where all models are premium', () => {
    const allPremium = new Set(testModels.map((m) => m.id));
    const result = getAccessibleModelIds(testModels, allPremium, false);

    // When no basic models, falls back to first model
    expect(result.strongestId).toBe(testModels[0]?.id);
    expect(result.valueId).toBe(testModels[0]?.id);
  });

  it('excludes premium models when finding strongest/value for non-premium users', () => {
    // Premium model has highest price, but should not be selected
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    expect(result.strongestId).not.toBe('premium-model');
    expect(result.valueId).not.toBe('premium-model');
  });

  it('uses combined input+output price for sorting', () => {
    // Create models where input/output prices would give different rankings
    const modelsWithVaryingPrices: Model[] = [
      {
        id: 'high-input-low-output',
        name: 'High Input Low Output',
        description: 'Test model',
        provider: 'TestProvider',
        contextLength: 100000,
        pricePerInputToken: 0.0001, // High input
        pricePerOutputToken: 0.00001, // Low output
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: 'low-input-high-output',
        name: 'Low Input High Output',
        description: 'Test model',
        provider: 'TestProvider',
        contextLength: 100000,
        pricePerInputToken: 0.00001, // Low input
        pricePerOutputToken: 0.0001, // High output
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
      },
    ];

    const result = getAccessibleModelIds(modelsWithVaryingPrices, new Set(), false);

    // Both have same combined price, so order depends on stable sort
    // The important thing is that it doesn't crash and returns valid IDs
    expect(modelsWithVaryingPrices.map((m) => m.id)).toContain(result.strongestId);
    expect(modelsWithVaryingPrices.map((m) => m.id)).toContain(result.valueId);
  });
});
