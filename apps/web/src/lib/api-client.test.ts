import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { deriveKeysFromLinkSecret, deriveLinkAuthToken } from '@hushbox/crypto';
import { LINK_CREDENTIAL_HEADER, toBase64 } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useAppVersionStore } from '@/stores/app-version';
import { ApiError } from './api/api.js';

type FetchCallWithInit = [Request | string | URL, RequestInit | undefined];

// Only the API origin is stood in for: it is registry-derived and differs per
// worktree, while every assertion below reads a field off the real error class,
// so substituting that class would make them assert the substitute.
vi.mock('./api/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/api.js')>()),
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('@/capacitor/platform.js', () => ({
  getPlatform: () => 'web',
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
        { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    type FetchCallArgs = [Request | string | URL];
    const callArgs = fetchSpy.mock.calls[0] as FetchCallArgs;
    const requestUrl = callArgs[0] instanceof Request ? callArgs[0].url : String(callArgs[0]);
    expect(requestUrl).toContain('http://localhost:8787/health');
  });

  it('uses credentials omit and sets header when link guest auth is active', async () => {
    const { setLinkGuestAuth, clearLinkGuestAuth } = await import('./auth/link-guest-auth.js');
    setLinkGuestAuth('test-auth-token-base64');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as FetchCallWithInit;
    const requestInit = callArgs[1];
    expect(requestInit?.credentials).toBe('omit');
    const headers = new Headers(requestInit?.headers);
    expect(headers.get(LINK_CREDENTIAL_HEADER)).toBe('test-auth-token-base64');

    clearLinkGuestAuth();
  });

  it("sends the link's auth token, never its public key, as the link credential", async () => {
    const { setLinkGuestAuth, clearLinkGuestAuth } = await import('./auth/link-guest-auth.js');
    const linkSecret = new Uint8Array(32).fill(9);
    const authToken = toBase64(deriveLinkAuthToken(linkSecret));
    setLinkGuestAuth(authToken);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ status: 'ok', timestamp: isoAt(TEST_DAY_START) }, { status: 200 })
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    const headers = new Headers((fetchSpy.mock.calls[0] as FetchCallWithInit)[1]?.headers);
    expect(headers.get(LINK_CREDENTIAL_HEADER)).toBe(authToken);
    expect(headers.get(LINK_CREDENTIAL_HEADER)).not.toBe(
      toBase64(deriveKeysFromLinkSecret(linkSecret).publicKey)
    );

    clearLinkGuestAuth();
  });

  it('sends no link credential when no link guest auth is set', async () => {
    const { clearLinkGuestAuth } = await import('./auth/link-guest-auth.js');
    clearLinkGuestAuth();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ status: 'ok', timestamp: isoAt(TEST_DAY_START) }, { status: 200 })
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    const headers = new Headers((fetchSpy.mock.calls[0] as FetchCallWithInit)[1]?.headers);
    expect(headers.has(LINK_CREDENTIAL_HEADER)).toBe(false);
  });

  it('includes credentials include in requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as FetchCallWithInit;
    const requestInit = callArgs[1];
    expect(requestInit?.credentials).toBe('include');
  });
});

describe('fetchJson', () => {
  beforeEach(() => {
    useAppVersionStore.setState({
      upgradeRequired: false,
      currentVersion: null,
      updateUrl: null,
    });
  });

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

  it('returns undefined on 204 No Content without trying to parse JSON', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(new Response(null, { status: 204 }));

    const result = await fetchJson(response);

    expect(result).toBeUndefined();
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

  it('carries the parsed Retry-After delay on a rate-limited response', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(
      Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '2' } })
    );

    const failure = await fetchJson(response).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).retryAfterMs).toBe(2000);
  });

  it('sets upgradeRequired in store on 426 response', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'UPGRADE_REQUIRED', currentVersion: 'abc123' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('UPGRADE_REQUIRED');
    expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
  });

  it('still throws ApiError on 426 after setting store', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'UPGRADE_REQUIRED', currentVersion: 'abc123' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(426);
    }
  });

  it('stashes currentVersion and updateUrl from a 426 body', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = {
      code: 'VERSION_MISMATCH',
      details: {
        currentVersion: 'srv-9',
        updateUrl: '/updates/download/ios/srv-9',
      },
    };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('VERSION_MISMATCH');

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBe('srv-9');
    expect(state.updateUrl).toBe('/updates/download/ios/srv-9');
  });

  it('nulls updateUrl on a web-platform 426 body carrying only currentVersion', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'VERSION_MISMATCH', details: { currentVersion: 'web-3' } };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('VERSION_MISMATCH');

    const state = useAppVersionStore.getState();
    expect(state.currentVersion).toBe('web-3');
    expect(state.updateUrl).toBeNull();
  });

  it('falls back to the boolean flag on a 426 with no parseable body', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(new Response('not json', { status: 426 }));

    await expect(fetchJson(response)).rejects.toThrow(ApiError);

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBeNull();
    expect(state.updateUrl).toBeNull();
  });
});

describe('idempotency-key fact on a failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failingFetch(): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ code: 'INTERNAL' }, { status: 500 })
    );
  }

  it('stamps a failure whose request carried an Idempotency-Key', async () => {
    failingFetch();
    const { client, fetchJson } = await import('./api-client.js');
    const { idempotentHeaders } = await import('./api/idempotent-mutation.js');

    const failure = await fetchJson(
      client.billing['login-link'].$post({}, idempotentHeaders({}))
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).carriedIdempotencyKey).toBe(true);
  });

  it('leaves a failure whose request carried no key unstamped', async () => {
    failingFetch();
    const { client, fetchJson } = await import('./api-client.js');

    const failure = await fetchJson(client.billing['login-link'].$post({})).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).carriedIdempotencyKey).toBe(false);
  });
});

describe('platform and version headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function getHeaderFromFetchCall(fetchCall: unknown[], headerName: string): string | null {
    const [req, init] = fetchCall as [Request | string | URL, RequestInit | undefined];
    if (req instanceof Request) {
      return req.headers.get(headerName);
    }
    if (init?.headers) {
      return new Headers(init.headers).get(headerName);
    }
    return null;
  }

  it('sends X-HushBox-Platform header with every request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    vi.resetModules();
    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const platform = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-HushBox-Platform');
    expect(platform).toBe('web');
  });

  it('sends X-App-Version header with every request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    vi.resetModules();
    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const version = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-App-Version');
    expect(version).toBe('dev-local');
  });

  it('reads X-App-Version from the registry env, not a hardcoded default', async () => {
    vi.stubEnv('VITE_APP_VERSION', 'srv-42');
    vi.resetModules();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: isoAt(TEST_DAY_START) },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    const version = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-App-Version');
    expect(version).toBe('srv-42');
  });

  it('fails fast (throws on import) when VITE_APP_VERSION is missing/empty', async () => {
    vi.stubEnv('VITE_APP_VERSION', '');
    vi.resetModules();
    await expect(import('./api-client.js')).rejects.toThrow();
  });
});
