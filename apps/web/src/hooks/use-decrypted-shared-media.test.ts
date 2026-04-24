import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDecryptBinaryWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  decryptBinaryWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptBinaryWithContentKey(...args),
}));

const mockCreateObjectURL = vi.fn<(blob: Blob) => string>();
const mockRevokeObjectURL = vi.fn<(url: string) => void>();
const mockFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

import { useDecryptedSharedMedia } from './use-decrypted-shared-media';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultParams(
  overrides: Partial<Parameters<typeof useDecryptedSharedMedia>[0]> = {}
): Parameters<typeof useDecryptedSharedMedia>[0] {
  return {
    downloadUrl: 'https://signed.example/img?sig=a',
    contentKey: new Uint8Array([4, 5, 6]),
    mimeType: 'image/png',
    ...overrides,
  };
}

function createFetchResponse(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDecryptedSharedMedia', () => {
  let urlCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => {
      urlCounter += 1;
      return `blob:shared-mock-${String(urlCounter)}`;
    });
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: fetches, decrypts with the provided contentKey, returns a blob URL', async () => {
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([10, 11, 12]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const contentKey = new Uint8Array([99, 99]);
    const { result } = renderHook(() => useDecryptedSharedMedia(defaultParams({ contentKey })));

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.blobUrl).toBe('blob:shared-mock-1');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('https://signed.example/img?sig=a');
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
    // decryptBinaryWithContentKey must be called with the exact contentKey we passed in.
    expect(mockDecryptBinaryWithContentKey.mock.calls[0]![0]).toBe(contentKey);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns loading state when downloadUrl is null', () => {
    const { result } = renderHook(() =>
      useDecryptedSharedMedia({
        downloadUrl: null,
        contentKey: new Uint8Array([1]),
        mimeType: 'image/png',
      })
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns loading state when contentKey is null', () => {
    const { result } = renderHook(() =>
      useDecryptedSharedMedia({
        downloadUrl: 'https://signed.example/x',
        contentKey: null,
        mimeType: 'image/png',
      })
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('error path: fetch returns non-ok status', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array(), false, 403));

    const { result } = renderHook(() => useDecryptedSharedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Media fetch failed');
    expect(result.current.error?.message).toContain('403');
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('error path: decryption throws', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2])));
    mockDecryptBinaryWithContentKey.mockImplementation(() => {
      throw new Error('AEAD tag mismatch');
    });

    const { result } = renderHook(() => useDecryptedSharedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('AEAD tag mismatch');
    expect(result.current.blobUrl).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    // Stabilize the params ref so the useEffect deps don't re-fire on each render.
    const stableParams = defaultParams();
    const { result, unmount } = renderHook(() => useDecryptedSharedMedia(stableParams));

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:shared-mock-1');
    });

    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:shared-mock-1');
  });

  it('does not set state from a stale fetch when downloadUrl changes mid-fetch', async () => {
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    let resolveFirstFetch: ((response: Response) => void) | undefined;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(firstFetchPromise);
    mockFetch.mockResolvedValueOnce(createFetchResponse(new Uint8Array([7, 8])));

    const { result, rerender } = renderHook(
      (params: Parameters<typeof useDecryptedSharedMedia>[0]) => useDecryptedSharedMedia(params),
      {
        initialProps: defaultParams({ downloadUrl: 'https://signed.example/first' }),
      }
    );

    rerender(defaultParams({ downloadUrl: 'https://signed.example/second' }));

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:shared-mock-1');
    });

    const stableBlobUrl = result.current.blobUrl;

    resolveFirstFetch?.(createFetchResponse(new Uint8Array([5, 5])));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.blobUrl).toBe(stableBlobUrl);
  });

  it('creates the Blob with the provided mimeType', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2, 3])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([4, 5, 6]));

    const { result } = renderHook(() =>
      useDecryptedSharedMedia(defaultParams({ mimeType: 'video/mp4' }))
    );

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    const blob = mockCreateObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('video/mp4');
  });
});
