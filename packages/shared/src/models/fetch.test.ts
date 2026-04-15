import { describe, it, expect, vi, afterEach } from 'vitest';

const mockGetAvailableModels = vi.fn();
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: () => ({
    getAvailableModels: mockGetAvailableModels,
  }),
}));

const { fetchModels, clearModelCache } = await import('./fetch.js');

afterEach(() => {
  clearModelCache();
  vi.clearAllMocks();
});

describe('fetchModels', () => {
  it('returns models from the AI Gateway, mapped to RawModel shape', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: 'Most capable',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ],
    });

    const result = await fetchModels('test-key');

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('openai/gpt-5');
    expect(result[0]?.name).toBe('GPT-5');
    expect(result[0]?.pricing.prompt).toBe('0.00001');
    expect(result[0]?.pricing.completion).toBe('0.00003');
  });

  it('caches the response per API key', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: '',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ],
    });

    await fetchModels('test-key');
    await fetchModels('test-key');

    expect(mockGetAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('refetches when API key changes', async () => {
    mockGetAvailableModels.mockResolvedValue({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: '',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ],
    });

    await fetchModels('key-1');
    await fetchModels('key-2');

    expect(mockGetAvailableModels).toHaveBeenCalledTimes(2);
  });

  it('handles models with null pricing gracefully', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: '',
          modelType: 'language',
          pricing: null,
        },
      ],
    });

    const result = await fetchModels('test-key');

    expect(result[0]?.pricing.prompt).toBe('0');
    expect(result[0]?.pricing.completion).toBe('0');
  });
});

// fetchZdrModelIds removed — ZDR is now per-model via isZdrModel (zdr.test.ts)
