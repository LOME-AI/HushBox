import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchModels, clearModelCache } from './fetch.js';

const mockFetch = vi.fn();

function mockPublicModels(entries: Record<string, unknown>[]): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: entries }),
  } as Response);
}

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

describe('fetchModels', () => {
  it('returns models from the public /v1/models endpoint, mapped to RawModel shape', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        description: 'Most capable',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('openai/gpt-5');
    expect(result[0]?.name).toBe('GPT-5');
    expect(result[0]?.modality).toBe('text');
    expect(result[0]?.pricing.prompt).toBe('0.00001');
    expect(result[0]?.pricing.completion).toBe('0.00003');
  });

  it('falls back to id for name and empty description when fields are missing', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.name).toBe('openai/gpt-5');
    expect(result[0]?.description).toBe('');
  });

  it('caches the response per publicModelsUrl', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });
    await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches when publicModelsUrl changes', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    await fetchModels({ publicModelsUrl: 'https://test-a.example/v1/models' });
    await fetchModels({ publicModelsUrl: 'https://test-b.example/v1/models' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles missing pricing keys gracefully', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.pricing.prompt).toBe('0');
    expect(result[0]?.pricing.completion).toBe('0');
  });

  it('uses context_window when provided, falling back to a default otherwise', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
        context_window: 1_000_000,
      },
      {
        id: 'openai/gpt-5-mini',
        name: 'GPT-5 Mini',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result.find((m) => m.id === 'openai/gpt-5')?.context_length).toBe(1_000_000);
    expect(result.find((m) => m.id === 'openai/gpt-5-mini')?.context_length).toBe(128_000);
  });

  it('classifies image models and maps per_image pricing', async () => {
    mockPublicModels([
      {
        id: 'google/imagen-4.0-generate-001',
        name: 'Imagen 4',
        type: 'image',
        pricing: { image: '0.04' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.modality).toBe('image');
    expect(result[0]?.pricing.per_image).toBe('0.04');
  });

  it('classifies video models and merges per-resolution pricing preferring audio:true', async () => {
    mockPublicModels([
      {
        id: 'google/veo-3.1-generate-001',
        name: 'Veo 3.1',
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

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.modality).toBe('video');
    expect(result[0]?.pricing.per_second_by_resolution).toEqual({
      '720p': '0.4',
      '1080p': '0.4',
    });
  });

  it('falls back to audio:false when a video resolution lacks an audio:true entry', async () => {
    mockPublicModels([
      {
        id: 'alibaba/wan-x',
        name: 'Wan',
        type: 'video',
        pricing: {
          video_duration_pricing: [{ resolution: '720p', audio: false, cost_per_second: '0.05' }],
        },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.pricing.per_second_by_resolution).toEqual({ '720p': '0.05' });
  });

  it('leaves image pricing absent when public entry has no flat image price', async () => {
    mockPublicModels([
      {
        id: 'google/imagen-4.0-generate-001',
        name: 'Imagen 4',
        type: 'image',
        pricing: {},
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.pricing.per_image).toBeUndefined();
  });

  it('leaves image pricing absent when the public entry uses image_dimension_quality_pricing', async () => {
    mockPublicModels([
      {
        id: 'google/gemini-3-pro-image',
        name: 'Gemini 3 Pro Image',
        type: 'image',
        pricing: {
          image_dimension_quality_pricing: [{ size: '1K', cost: '0.13' }],
        },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.pricing.per_image).toBeUndefined();
  });

  it('leaves video pricing absent when the public entry uses video_token_pricing', async () => {
    mockPublicModels([
      {
        id: 'bytedance/seedance-2.0',
        name: 'Seedance 2.0',
        type: 'video',
        pricing: {
          video_token_pricing: { no_video_input: { cost_per_million_tokens: '1.5' } },
        },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.pricing.per_second_by_resolution).toBeUndefined();
  });

  it('throws a clear error when the public endpoint returns a non-2xx status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: () => Promise.resolve({}),
    } as unknown as Response);

    await expect(
      fetchModels({ publicModelsUrl: 'https://test.example/v1/models' })
    ).rejects.toThrowError(/503/);
  });

  it('throws a clear error when the public endpoint throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    await expect(
      fetchModels({ publicModelsUrl: 'https://test.example/v1/models' })
    ).rejects.toThrowError(/network error/i);
  });

  it('throws a Zod parse error when the public response shape drifts', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ unexpected: 'shape' }),
    } as Response);

    await expect(
      fetchModels({ publicModelsUrl: 'https://test.example/v1/models' })
    ).rejects.toThrowError();
  });

  it('passes the configured URL to fetch', async () => {
    mockPublicModels([]);

    await fetchModels({ publicModelsUrl: 'https://custom.example/v1/models' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.example/v1/models',
      expect.objectContaining({ signal: expect.any(AbortSignal) }) as { signal: AbortSignal }
    );
  });

  it('uses created timestamp from public response when provided', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
        created: 1_700_000_000,
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.created).toBe(1_700_000_000);
  });

  it('builds text architecture for text models', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.architecture).toEqual({
      input_modalities: ['text'],
      output_modalities: ['text'],
    });
  });

  it('builds image architecture for image models', async () => {
    mockPublicModels([
      {
        id: 'google/imagen-4.0-generate-001',
        name: 'Imagen 4',
        type: 'image',
        pricing: { image: '0.04' },
      },
    ]);

    const result = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(result[0]?.architecture).toEqual({
      input_modalities: ['image'],
      output_modalities: ['image'],
    });
  });

  it('aborts the fetch with a clear error after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      // The hanging promise rejects when `controller.abort()` fires the signal.
      mockFetch.mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const aborted = new Error('aborted');
              aborted.name = 'AbortError';
              reject(aborted);
            });
          })
      );

      const captured = (async (): Promise<unknown> => {
        try {
          await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });
          return new Error('fetchModels resolved unexpectedly');
        } catch (error_: unknown) {
          return error_;
        }
      })();
      await vi.advanceTimersByTimeAsync(11_000);
      const error = await captured;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out|abort/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes an AbortSignal to fetch', async () => {
    mockPublicModels([]);

    await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    const call = mockFetch.mock.calls[0];
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('isolates the cached array from caller mutations', async () => {
    mockPublicModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        type: 'language',
        pricing: { input: '0.00001', output: '0.00003' },
      },
    ]);

    const first = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });
    first.push({
      id: 'malicious-injection',
      name: 'inj',
      description: '',
      modality: 'text',
      context_length: 0,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
      created: 0,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    });

    const second = await fetchModels({ publicModelsUrl: 'https://test.example/v1/models' });

    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('openai/gpt-5');
    expect(second.some((m) => m.id === 'malicious-injection')).toBe(false);
  });
});
