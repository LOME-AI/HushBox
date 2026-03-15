import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchModels, fetchZdrModelIds, clearModelCache } from './fetch.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  clearModelCache();
  vi.restoreAllMocks();
});

describe('fetchModels', () => {
  it('returns models from OpenRouter API', async () => {
    const models = [{ id: 'openai/gpt-4', name: 'GPT-4' }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: models }),
    });

    const result = await fetchModels();

    expect(result).toEqual(models);
    expect(mockFetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models');
  });

  it('throws when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(fetchModels()).rejects.toThrow('Failed to fetch models');
  });
});

describe('fetchZdrModelIds', () => {
  it('returns set of ZDR model IDs', async () => {
    const endpoints = [
      { model_id: 'openai/gpt-4', model_name: 'GPT-4', provider_name: 'OpenAI' },
      { model_id: 'anthropic/claude', model_name: 'Claude', provider_name: 'Anthropic' },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: endpoints }),
    });

    const result = await fetchZdrModelIds();

    expect(result).toBeInstanceOf(Set);
    expect(result.has('openai/gpt-4')).toBe(true);
    expect(result.has('anthropic/claude')).toBe(true);
    expect(result.size).toBe(2);
    expect(mockFetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/endpoints/zdr');
  });

  it('throws when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(fetchZdrModelIds()).rejects.toThrow('Failed to fetch ZDR endpoints');
  });
});
