import { describe, it, expect, vi } from 'vitest';
import { loadCatalogAtBuild } from './catalog-at-build';
import type { Model } from '@hushbox/shared';

const API_URL = 'https://api.example.test';
const MODELS_URL = `${API_URL}/models`;

const MODEL: Model = {
  id: 'test/model',
  name: 'Test Model',
  provider: 'Test',
  modality: 'text',
  contextLength: 128_000,
  pricing: { inputPerToken: '1000', outputPerToken: '2000' },
  description: 'A test model',
  supportedParameters: ['temperature'],
};

function answering(response: Response): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const failures: readonly {
  name: string;
  fetch: () => typeof fetch;
  status: number | 'network';
}[] = [
  {
    name: 'a fetch that throws',
    fetch: () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
    status: 'network',
  },
  {
    name: 'a 503 answer',
    fetch: () => answering(new Response('unavailable', { status: 503 })),
    status: 503,
  },
  {
    name: 'a body that fails the schema',
    fetch: () => answering(jsonResponse({ models: [{ id: '' }] })),
    status: 200,
  },
  {
    name: 'a body that is not JSON',
    fetch: () => answering(new Response('<html></html>', { status: 200 })),
    status: 200,
  },
];

describe('loadCatalogAtBuild', () => {
  it('requests the models listing under the API URL', async () => {
    const fetchModels = answering(jsonResponse({ models: [MODEL], premiumModelIds: [] }));
    await loadCatalogAtBuild(API_URL, { fetch: fetchModels, isProduction: true });
    expect(fetchModels).toHaveBeenCalledWith(MODELS_URL);
  });

  it('yields the models of a body the schema accepts', async () => {
    const result = await loadCatalogAtBuild(API_URL, {
      fetch: answering(jsonResponse({ models: [MODEL], premiumModelIds: [] })),
      isProduction: false,
    });
    expect(result).toEqual({ kind: 'ok', models: [MODEL] });
  });

  describe.each(failures)('on $name', ({ fetch, status }) => {
    it('fails a production build with an error naming the URL', async () => {
      await expect(
        loadCatalogAtBuild(API_URL, { fetch: fetch(), isProduction: true })
      ).rejects.toThrow(MODELS_URL);
    });

    it('fails a production build with an error naming the status', async () => {
      await expect(
        loadCatalogAtBuild(API_URL, { fetch: fetch(), isProduction: true })
      ).rejects.toThrow(String(status));
    });

    it('reports the catalog unavailable to any other build', async () => {
      const result = await loadCatalogAtBuild(API_URL, { fetch: fetch(), isProduction: false });
      expect(result).toEqual({ kind: 'unavailable', url: MODELS_URL, status });
    });
  });
});
