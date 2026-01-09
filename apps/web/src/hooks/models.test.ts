import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { Model } from '@lome-chat/shared';
import { useModels } from './models.js';

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
