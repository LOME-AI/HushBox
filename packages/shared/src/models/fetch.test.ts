import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const mockGetAvailableModels = vi.fn();
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: () => ({
    getAvailableModels: mockGetAvailableModels,
  }),
}));

const { fetchModels, clearModelCache } = await import('./fetch.js');

// Default: no public-endpoint entries. Individual tests override to simulate
// the `https://ai-gateway.vercel.sh/v1/models` response when media pricing matters.
const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
  } as Response);
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  clearModelCache();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mockPublicModels(entries: Record<string, unknown>[]): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: entries }),
  } as Response);
}

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

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('openai/gpt-5');
    expect(result[0]?.name).toBe('GPT-5');
    expect(result[0]?.modality).toBe('text');
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

    await fetchModels({ apiKey: 'test-key', publicModelsUrl: 'https://test.example/v1/models' });
    await fetchModels({ apiKey: 'test-key', publicModelsUrl: 'https://test.example/v1/models' });

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

    await fetchModels({ apiKey: 'key-1', publicModelsUrl: 'https://test.example/v1/models' });
    await fetchModels({ apiKey: 'key-2', publicModelsUrl: 'https://test.example/v1/models' });

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

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.pricing.prompt).toBe('0');
    expect(result[0]?.pricing.completion).toBe('0');
  });

  it('classifies image models and merges per_image pricing from public endpoint', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'google/imagen-4.0-generate-001',
          name: 'Imagen 4',
          description: 'flat-priced image model',
          modelType: 'image',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([
      {
        id: 'google/imagen-4.0-generate-001',
        type: 'image',
        pricing: { image: '0.04' },
      },
    ]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.modality).toBe('image');
    expect(result[0]?.pricing.per_image).toBe('0.04');
  });

  it('classifies video models and merges per-resolution pricing preferring audio:true', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3.1',
          description: 'video with audio',
          modelType: 'video',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([
      {
        id: 'google/veo-3.1-generate-001',
        type: 'video',
        pricing: {
          video_duration_pricing: [
            { resolution: '720p', audio: false, cost_per_second: '0.2' },
            { resolution: '720p', audio: true, cost_per_second: '0.4' },
            { resolution: '1080p', audio: false, cost_per_second: '0.2' },
            { resolution: '1080p', audio: true, cost_per_second: '0.4' },
          ],
        },
      },
    ]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.modality).toBe('video');
    expect(result[0]?.pricing.per_second_by_resolution).toEqual({
      '720p': '0.4',
      '1080p': '0.4',
    });
  });

  it('falls back to audio:false when a video resolution lacks an audio:true entry', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'alibaba/wan-x',
          name: 'Wan',
          description: '',
          modelType: 'video',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([
      {
        id: 'alibaba/wan-x',
        type: 'video',
        pricing: {
          video_duration_pricing: [{ resolution: '720p', audio: false, cost_per_second: '0.05' }],
        },
      },
    ]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.pricing.per_second_by_resolution).toEqual({ '720p': '0.05' });
  });

  it('leaves image pricing empty when public endpoint has no matching entry', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'google/imagen-4.0-generate-001',
          name: 'Imagen 4',
          description: '',
          modelType: 'image',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.pricing.per_image).toBeUndefined();
  });

  it('leaves image pricing empty when the public entry uses image_dimension_quality_pricing', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'google/gemini-3-pro-image',
          name: 'Gemini 3 Pro Image',
          description: '',
          modelType: 'image',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([
      {
        id: 'google/gemini-3-pro-image',
        type: 'image',
        pricing: {
          image_dimension_quality_pricing: [{ size: '1K', cost: '0.13' }],
        },
      },
    ]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.pricing.per_image).toBeUndefined();
  });

  it('leaves video pricing empty when the public entry uses video_token_pricing', async () => {
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'bytedance/seedance-2.0',
          name: 'Seedance 2.0',
          description: '',
          modelType: 'video',
          pricing: { input: '0', output: '0' },
        },
      ],
    });
    mockPublicModels([
      {
        id: 'bytedance/seedance-2.0',
        type: 'video',
        pricing: {
          video_token_pricing: { no_video_input: { cost_per_million_tokens: '1.5' } },
        },
      },
    ]);

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    expect(result[0]?.pricing.per_second_by_resolution).toBeUndefined();
  });

  it('degrades gracefully when the public endpoint returns a non-2xx status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: '',
          modelType: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
        {
          id: 'google/imagen-4.0-generate-001',
          name: 'Imagen 4',
          description: '',
          modelType: 'image',
          pricing: { input: '0', output: '0' },
        },
      ],
    });

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });

    // Text model still present; image model present but without media pricing
    expect(result).toHaveLength(2);
    const textModel = result.find((m) => m.id === 'openai/gpt-5');
    const imageModel = result.find((m) => m.id === 'google/imagen-4.0-generate-001');
    expect(textModel?.pricing.prompt).toBe('0.00001');
    expect(imageModel?.pricing.per_image).toBeUndefined();
  });

  it('degrades gracefully when the public endpoint throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
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

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.pricing.prompt).toBe('0.00001');
  });

  it('degrades gracefully when the public endpoint returns a malformed body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ unexpected: 'shape' }),
    } as Response);
    mockGetAvailableModels.mockResolvedValueOnce({
      models: [
        {
          id: 'google/imagen-4.0-generate-001',
          name: 'Imagen 4',
          description: '',
          modelType: 'image',
          pricing: { input: '0', output: '0' },
        },
      ],
    });

    const result = await fetchModels({
      apiKey: 'test-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });
    expect(result[0]?.pricing.per_image).toBeUndefined();
  });

  it('does not call the public endpoint more than once per cache TTL', async () => {
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

    await fetchModels({ apiKey: 'test-key', publicModelsUrl: 'https://test.example/v1/models' });
    await fetchModels({ apiKey: 'test-key', publicModelsUrl: 'https://test.example/v1/models' });

    const publicCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes('test.example/v1/models')
    );
    expect(publicCalls.length).toBe(1);
  });
});
