import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import { z } from 'zod';
import { usePublicQuery } from './use-public-query';

const testSchema = z.object({ value: z.string() });
type TestPayload = z.infer<typeof testSchema>;

const VALID_RESPONSE: TestPayload = { value: 'ok' };

function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function useExampleQuery(): ReturnType<typeof usePublicQuery<TestPayload>> {
  return usePublicQuery('/public/example', testSchema, 'example');
}

function renderQuery(): ReturnType<
  typeof renderHook<ReturnType<typeof useExampleQuery>, undefined>
> {
  return renderHook(useExampleQuery);
}

describe('usePublicQuery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('starts in the loading state before the fetch resolves', () => {
    stubFetch(() => new Promise(() => {}));
    const { result } = renderQuery();
    expect(result.current).toEqual({ data: null, error: null, isLoading: true });
  });

  it('resolves to the validated data on a successful fetch', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.data).toEqual(VALID_RESPONSE);
    expect(result.current.error).toBeNull();
  });

  it('requests the given path against VITE_API_URL', async () => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        requestedUrl = String(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(VALID_RESPONSE),
        });
      })
    );
    renderQuery();
    await waitFor(() => {
      expect(requestedUrl).not.toBe('');
    });
    expect(requestedUrl).toContain('/public/example');
  });

  it('surfaces a labeled error state when the response is not ok', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error?.message).toBe('example request failed: 503');
  });

  it('surfaces an error state when the payload fails schema validation', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ value: 42 }) })
    );
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.data).toBeNull();
  });

  it('wraps a non-Error rejection in a labeled Error before exposing it', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately rejecting with a non-Error string to exercise the hook's `error instanceof Error ? … : new Error(…)` fallback.
    stubFetch(() => Promise.reject('boom'));
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
    expect(result.current.error?.message).toBe('unknown example error');
  });

  it('ignores a successful response that lands after unmount', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    const { result, unmount } = renderQuery();
    unmount();
    // Flush the whole async fetch body (a macrotask) after the cleanup has set
    // the cancelled flag, so the success guard runs and swallows the result.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('ignores a fetch rejection that lands after unmount', async () => {
    stubFetch(() => Promise.reject(new Error('late failure')));
    const { result, unmount } = renderQuery();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });

  it('sends the request without credentials', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/example'),
      expect.objectContaining({ credentials: 'omit' })
    );
  });

  it('shares one request between two instances reading the same path', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = renderQuery();
    const second = renderQuery();
    await waitFor(() => {
      expect(first.result.current.data).toEqual(VALID_RESPONSE);
    });
    await waitFor(() => {
      expect(second.result.current.data).toEqual(VALID_RESPONSE);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts a later instance in the loading state after the shared request has resolved', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    const first = renderQuery();
    await waitFor(() => {
      expect(first.result.current.data).toEqual(VALID_RESPONSE);
    });
    const firstRenders: boolean[] = [];
    function Probe(): null {
      const state = useExampleQuery();
      firstRenders.push(state.isLoading);
      return null;
    }
    render(<Probe />);
    await waitFor(() => {
      expect(firstRenders.at(-1)).toBe(false);
    });
    expect(firstRenders[0]).toBe(true);
  });

  it('keeps a failed request failed for a later instance rather than asking again', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderQuery();
    await waitFor(() => {
      expect(first.result.current.error).not.toBeNull();
    });
    const second = renderQuery();
    await waitFor(() => {
      expect(second.result.current.error?.message).toBe('offline');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('labels a failed status with the label of the instance reading it', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) }));
    const first = renderQuery();
    const second = renderHook(() => usePublicQuery('/public/example', testSchema, 'other'));
    await waitFor(() => {
      expect(first.result.current.error?.message).toBe('example request failed: 502');
    });
    await waitFor(() => {
      expect(second.result.current.error?.message).toBe('other request failed: 502');
    });
  });

  it('validates the shared body against each instance schema', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    const lenient = renderQuery();
    const strict = renderHook(() =>
      usePublicQuery('/public/example', z.object({ value: z.literal('other') }), 'strict')
    );
    await waitFor(() => {
      expect(lenient.result.current.data).toEqual(VALID_RESPONSE);
    });
    await waitFor(() => {
      expect(strict.result.current.error).not.toBeNull();
    });
    expect(strict.result.current.data).toBeNull();
  });

  it('reports a missing VITE_API_URL through the error state instead of at module load', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VALID_RESPONSE) })
    );
    vi.stubEnv('VITE_API_URL', '');
    const { result } = renderQuery();
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error?.message).toMatch(/VITE_API_URL/);
    expect(result.current.isLoading).toBe(false);
  });
});
