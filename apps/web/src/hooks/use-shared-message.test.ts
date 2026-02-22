import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      shares: {
        [':shareId']: {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

const mockDecryptMessageShare = vi.fn<(secret: Uint8Array, blob: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  decryptMessageShare: (secret: Uint8Array, blob: Uint8Array) =>
    mockDecryptMessageShare(secret, blob),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSharedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is disabled when shareId is null', async () => {
    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage(null, 'some-key'), {
      wrapper: createWrapper(),
    });

    // Query should not fetch
    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is disabled when keyBase64 is null', async () => {
    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-123', null), {
      wrapper: createWrapper(),
    });

    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('calls fetchJson with correct shareId param', async () => {
    const fakeKey = new Uint8Array([1, 2, 3]);
    const fakeBlob = new Uint8Array([4, 5, 6]);

    mockFromBase64.mockImplementation((b64: string) => {
      if (b64 === 'key-b64') return fakeKey;
      if (b64 === 'blob-b64') return fakeBlob;
      return new Uint8Array();
    });

    mockFetchJson.mockResolvedValue({
      shareId: 'share-abc',
      messageId: 'msg-1',
      shareBlob: 'blob-b64',
      createdAt: '2026-01-15T10:00:00Z',
    });

    mockDecryptMessageShare.mockReturnValue('Decrypted content');

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', 'key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const { client } = await import('@/lib/api-client');
    expect(client.api.shares[':shareId'].$get).toHaveBeenCalledWith({
      param: { shareId: 'share-abc' },
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('decrypts shareBlob with key from base64', async () => {
    const fakeKey = new Uint8Array([10, 20]);
    const fakeBlob = new Uint8Array([30, 40]);

    mockFromBase64.mockImplementation((b64: string) => {
      if (b64 === 'the-key') return fakeKey;
      if (b64 === 'the-blob') return fakeBlob;
      return new Uint8Array();
    });

    mockFetchJson.mockResolvedValue({
      shareId: 'share-1',
      messageId: 'msg-1',
      shareBlob: 'the-blob',
      createdAt: '2026-02-01T00:00:00Z',
    });

    mockDecryptMessageShare.mockReturnValue('Hello from shared message');

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-1', 'the-key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockDecryptMessageShare).toHaveBeenCalledWith(fakeKey, fakeBlob);
    expect(result.current.data).toEqual({
      content: 'Hello from shared message',
      createdAt: '2026-02-01T00:00:00Z',
    });
  });

  it('returns content and createdAt on success', async () => {
    mockFromBase64.mockReturnValue(new Uint8Array([1]));
    mockFetchJson.mockResolvedValue({
      shareId: 'share-x',
      messageId: 'msg-x',
      shareBlob: 'blob',
      createdAt: '2026-03-15T12:00:00Z',
    });
    mockDecryptMessageShare.mockReturnValue('The decrypted text');

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-x', 'key-x'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({
      content: 'The decrypted text',
      createdAt: '2026-03-15T12:00:00Z',
    });
  });

  it('propagates errors from fetchJson', async () => {
    mockFromBase64.mockReturnValue(new Uint8Array([1]));
    mockFetchJson.mockRejectedValue(new Error('Not found'));

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-bad', 'key-bad'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe('Not found');
  });

  it('propagates errors from decryptMessageShare', async () => {
    mockFromBase64.mockReturnValue(new Uint8Array([1]));
    mockFetchJson.mockResolvedValue({
      shareId: 'share-corrupt',
      messageId: 'msg-corrupt',
      shareBlob: 'corrupt-blob',
      createdAt: '2026-01-01T00:00:00Z',
    });
    mockDecryptMessageShare.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-corrupt', 'wrong-key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error!.message).toBe('Decryption failed');
  });
});
