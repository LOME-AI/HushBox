import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockDecryptBinaryWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  decryptBinaryWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptBinaryWithContentKey(...args),
}));

const mockCreateObjectURL = vi.fn<(blob: Blob) => string>();
const mockRevokeObjectURL = vi.fn<(url: string) => void>();
const mockFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

import { useDecryptBlob } from './use-decrypt-blob';

function defaultParams(
  overrides: Partial<Parameters<typeof useDecryptBlob>[0]> = {}
): Parameters<typeof useDecryptBlob>[0] {
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

describe('useDecryptBlob', () => {
  let urlCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => {
      urlCounter += 1;
      return `blob:decrypt-blob-mock-${String(urlCounter)}`;
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

  it('fetches, decrypts with the provided contentKey, and returns a blob URL', async () => {
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([10, 11, 12]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const contentKey = new Uint8Array([99, 99]);
    const { result } = renderHook(() => useDecryptBlob(defaultParams({ contentKey })));

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('https://signed.example/img?sig=a');
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
    expect(mockDecryptBinaryWithContentKey.mock.calls[0]![0]).toBe(contentKey);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns loading state when downloadUrl is null', () => {
    const { result } = renderHook(() =>
      useDecryptBlob({
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
      useDecryptBlob({
        downloadUrl: 'https://signed.example/x',
        contentKey: null,
        mimeType: 'image/png',
      })
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exposes an error when fetch returns a non-ok status', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array(), false, 403));

    const { result } = renderHook(() => useDecryptBlob(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Media fetch failed');
    expect(result.current.error?.message).toContain('403');
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('exposes an error when decryption throws', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2])));
    mockDecryptBinaryWithContentKey.mockImplementation(() => {
      throw new Error('AEAD tag mismatch');
    });

    const { result } = renderHook(() => useDecryptBlob(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('AEAD tag mismatch');
    expect(result.current.blobUrl).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const stableParams = defaultParams();
    const { result, unmount } = renderHook(() => useDecryptBlob(stableParams));

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    });

    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:decrypt-blob-mock-1');
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
      (params: Parameters<typeof useDecryptBlob>[0]) => useDecryptBlob(params),
      {
        initialProps: defaultParams({ downloadUrl: 'https://signed.example/first' }),
      }
    );

    rerender(defaultParams({ downloadUrl: 'https://signed.example/second' }));

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    });

    const stableBlobUrl = result.current.blobUrl;

    resolveFirstFetch?.(createFetchResponse(new Uint8Array([5, 5])));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.blobUrl).toBe(stableBlobUrl);
  });

  it('creates the Blob with the provided mimeType', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2, 3])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([4, 5, 6]));

    const { result } = renderHook(() => useDecryptBlob(defaultParams({ mimeType: 'video/mp4' })));

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    const blob = mockCreateObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('video/mp4');
  });
});
