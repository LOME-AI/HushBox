import { describe, it, expect, vi, afterEach } from 'vitest';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

vi.mock('./api.js', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError,
}));

describe('api-client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports a client object', async () => {
    const { client } = await import('./api-client.js');
    expect(client).toBeDefined();
  });

  it('makes requests to the correct API URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.api.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as [Request | string | URL];
    const requestUrl = callArgs[0] instanceof Request ? callArgs[0].url : String(callArgs[0]);
    expect(requestUrl).toContain('http://localhost:8787/api/health');
  });

  it('includes credentials include in requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.api.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as [Request | string | URL, RequestInit | undefined];
    const requestInit = callArgs[1];
    expect(requestInit?.credentials).toBe('include');
  });
});

describe('fetchJson', () => {
  it('returns parsed JSON on successful response', async () => {
    const { fetchJson } = await import('./api-client.js');
    const data = { id: '1', name: 'test' };
    const response = Promise.resolve(
      Response.json(data, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await fetchJson<{ id: string; name: string }>(response);

    expect(result).toEqual(data);
  });

  it('throws ApiError on non-ok response with error field', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'NOT_FOUND' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow(ApiError);
    await expect(
      fetchJson(
        Promise.resolve(
          Response.json(errorBody, {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    ).rejects.toThrow('NOT_FOUND');
  });

  it('throws ApiError with "Request failed" when response has no error field', async () => {
    const { fetchJson } = await import('./api-client.js');
    const body = { something: 'else' };
    const response = Promise.resolve(
      Response.json(body, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('INTERNAL');
  });

  it('throws ApiError when response body is not valid JSON', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(
      new Response('not json', {
        status: 502,
      })
    );

    await expect(fetchJson(response)).rejects.toThrow(ApiError);
    await expect(
      fetchJson(
        Promise.resolve(
          new Response('not json', {
            status: 502,
          })
        )
      )
    ).rejects.toThrow('INTERNAL');
  });

  it('preserves status code in ApiError', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(
      Response.json(
        { code: 'FORBIDDEN' },
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
    }
  });

  it('preserves response body data in ApiError', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'VALIDATION', details: ['field required'] };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).data).toEqual(errorBody);
    }
  });
});
