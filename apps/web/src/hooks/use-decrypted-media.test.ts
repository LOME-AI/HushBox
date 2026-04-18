import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseMediaDownloadUrl = vi.fn<
  (contentItemId: string | null) => {
    downloadUrl: string | undefined;
    isLoading: boolean;
    error: Error | null;
  }
>();

vi.mock('@/hooks/use-media-url', () => ({
  useMediaDownloadUrl: (contentItemId: string | null) => mockUseMediaDownloadUrl(contentItemId),
}));

const mockGetEpochKey =
  vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | undefined>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockDecryptBinaryWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  decryptBinaryWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptBinaryWithContentKey(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => new TextEncoder().encode(b64),
  };
});

// Stub URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = vi.fn<(blob: Blob) => string>();
const mockRevokeObjectURL = vi.fn<(url: string) => void>();

// Stub global fetch
const mockFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

import { useDecryptedMedia } from './use-decrypted-media';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultParams(
  overrides: Partial<Parameters<typeof useDecryptedMedia>[0]> = {}
): Parameters<typeof useDecryptedMedia>[0] {
  return {
    contentItemId: 'content-item-1',
    conversationId: 'conv-1',
    epochNumber: 1,
    wrappedContentKey: 'wrapped-content-key-b64',
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

describe('useDecryptedMedia', () => {
  let urlCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => {
      urlCounter += 1;
      return `blob:mock-${String(urlCounter)}`;
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

  it('happy path: fetches, decrypts, and returns a blob URL', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.blobUrl).toBe('blob:mock-1');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('https://r2.example.com/encrypted-bytes');
    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('forwards urlLoading as isLoading while the presigned URL is fetching', () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: undefined,
      isLoading: true,
      error: null,
    });

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
  });

  it('surfaces urlError from useMediaDownloadUrl', () => {
    const error = new Error('presigned url failed');
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: undefined,
      isLoading: false,
      error,
    });

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    expect(result.current.error).toBe(error);
    expect(result.current.blobUrl).toBeNull();
  });

  it('error path: missing epoch key returns an error', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReset();

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Epoch key not available');
    expect(result.current.blobUrl).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('error path: fetch returns non-ok status', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array(), false, 403));

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Media fetch failed');
    expect(result.current.error?.message).toContain('403');
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('error path: decryption throws', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockImplementation(() => {
      throw new Error('AEAD tag mismatch');
    });

    const { result } = renderHook(() => useDecryptedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('AEAD tag mismatch');
    expect(result.current.blobUrl).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const { result, unmount } = renderHook(() => useDecryptedMedia(defaultParams()));

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-1');
    });

    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('does not set state from a stale fetch when params change mid-fetch', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/first',
      isLoading: false,
      error: null,
    });
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9, 9]));

    // Hold the first fetch pending, resolve the second immediately
    let resolveFirstFetch: ((response: Response) => void) | undefined;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(firstFetchPromise);
    mockFetch.mockResolvedValueOnce(createFetchResponse(new Uint8Array([7, 8])));

    const { result, rerender } = renderHook(
      (params: Parameters<typeof useDecryptedMedia>[0]) => useDecryptedMedia(params),
      {
        initialProps: defaultParams(),
      }
    );

    // Change the params so the effect re-runs before the first fetch resolves
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/second',
      isLoading: false,
      error: null,
    });
    rerender(defaultParams({ wrappedContentKey: 'different-key-b64' }));

    // Second render resolves first, setting blobUrl
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-1');
    });

    const blobUrlAfterRerender = result.current.blobUrl;

    // Now resolve the first (stale) fetch — its state update should be a no-op
    resolveFirstFetch?.(createFetchResponse(new Uint8Array([5, 5])));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // blobUrl should not change from the second render's blob URL
    expect(result.current.blobUrl).toBe(blobUrlAfterRerender);
  });
});
