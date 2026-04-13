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
      messages: {
        share: {
          $post: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

const mockGetEpochKey = vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | null>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockCreateShare =
  vi.fn<(contentKey: Uint8Array) => { shareSecret: Uint8Array; wrappedShareKey: Uint8Array }>();

vi.mock('@hushbox/crypto', () => ({
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  createShare: (contentKey: Uint8Array) => mockCreateShare(contentKey),
}));

const mockToBase64 = vi.fn<(data: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: (data: Uint8Array) => mockToBase64(data),
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
      mutations: { retry: false },
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

describe('useMessageShare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromBase64.mockImplementation((b64) => new TextEncoder().encode(b64));
  });

  it('unwraps the content key, wraps it for share, and returns shareId + URL', async () => {
    const epochKey = new Uint8Array([7, 7, 7]);
    const contentKey = new Uint8Array([8, 8, 8]);
    const fakeSecret = new Uint8Array([1, 2, 3]);
    const fakeWrapped = new Uint8Array([4, 5, 6]);

    mockGetEpochKey.mockReturnValue(epochKey);
    mockOpenMessageEnvelope.mockReturnValue(contentKey);
    mockCreateShare.mockReturnValue({
      shareSecret: fakeSecret,
      wrappedShareKey: fakeWrapped,
    });
    mockToBase64.mockImplementation((data: Uint8Array) => {
      if (data === fakeWrapped) return 'encoded-wrapped';
      if (data === fakeSecret) return 'encoded-secret';
      return 'unknown';
    });

    mockFetchJson.mockResolvedValue({ shareId: 'share-abc' });

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    let mutationResult: { shareId: string; url: string } | undefined;
    await waitFor(async () => {
      mutationResult = await result.current.mutateAsync({
        messageId: 'msg-123',
        conversationId: 'conv-1',
        epochNumber: 2,
        wrappedContentKey: 'base64-wrapped-content-key',
      });
    });

    expect(mockGetEpochKey).toHaveBeenCalledWith('conv-1', 2);
    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
    const [openArgumentKey] = mockOpenMessageEnvelope.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(openArgumentKey).toBe(epochKey);
    expect(mockCreateShare).toHaveBeenCalledWith(contentKey);
    expect(mutationResult).toEqual({
      shareId: 'share-abc',
      url: 'http://localhost:3000/share/m/share-abc#encoded-secret',
    });
  });

  it('POSTs to /api/messages/share with wrappedShareKey (not shareBlob)', async () => {
    const fakeWrapped = new Uint8Array([10, 20, 30]);
    mockGetEpochKey.mockReturnValue(new Uint8Array([1]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([2]));
    mockCreateShare.mockReturnValue({
      shareSecret: new Uint8Array([3]),
      wrappedShareKey: fakeWrapped,
    });

    mockToBase64.mockImplementation((data: Uint8Array) => {
      if (data === fakeWrapped) return 'wrapped-b64';
      return 'secret-b64';
    });

    mockFetchJson.mockResolvedValue({ shareId: 'share-xyz' });

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await waitFor(async () => {
      await result.current.mutateAsync({
        messageId: 'msg-42',
        conversationId: 'conv-1',
        epochNumber: 1,
        wrappedContentKey: 'key-b64',
      });
    });

    const { client } = await import('@/lib/api-client');
    expect(client.api.messages.share.$post).toHaveBeenCalledWith({
      json: { messageId: 'msg-42', wrappedShareKey: 'wrapped-b64' },
    });
  });

  it('throws when the epoch key is not available in the cache', async () => {
    mockGetEpochKey.mockReturnValue(null);

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        epochNumber: 1,
        wrappedContentKey: 'key-b64',
      })
    ).rejects.toThrow();

    expect(mockCreateShare).not.toHaveBeenCalled();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('propagates errors from fetchJson', async () => {
    mockGetEpochKey.mockReturnValue(new Uint8Array([1]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([2]));
    mockCreateShare.mockReturnValue({
      shareSecret: new Uint8Array([3]),
      wrappedShareKey: new Uint8Array([4]),
    });
    mockToBase64.mockReturnValue('base64');
    mockFetchJson.mockRejectedValue(new Error('Server error'));

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        epochNumber: 1,
        wrappedContentKey: 'key-b64',
      })
    ).rejects.toThrow('Server error');
  });
});
