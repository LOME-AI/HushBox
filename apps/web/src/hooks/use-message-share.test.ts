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

const mockCreateMessageShare =
  vi.fn<(plaintext: string) => { shareSecret: Uint8Array; shareBlob: Uint8Array }>();
const mockToBase64 = vi.fn<(data: Uint8Array) => string>();

vi.mock('@hushbox/crypto', () => ({
  createMessageShare: (plaintext: string) => mockCreateMessageShare(plaintext),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: (data: Uint8Array) => mockToBase64(data),
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
  });

  it('returns shareId and URL with base64 key in hash fragment', async () => {
    const fakeSecret = new Uint8Array([1, 2, 3]);
    const fakeBlob = new Uint8Array([4, 5, 6]);

    mockCreateMessageShare.mockReturnValue({
      shareSecret: fakeSecret,
      shareBlob: fakeBlob,
    });

    mockToBase64.mockImplementation((data: Uint8Array) => {
      if (data === fakeBlob) return 'encoded-blob';
      if (data === fakeSecret) return 'encoded-secret';
      return 'unknown';
    });

    mockFetchJson.mockResolvedValue({ shareId: 'share-abc' });

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), {
      wrapper: createWrapper(),
    });

    let mutationResult: { shareId: string; url: string } | undefined;
    await waitFor(async () => {
      mutationResult = await result.current.mutateAsync({
        messageId: 'msg-123',
        plaintextContent: 'Hello world',
      });
    });

    expect(mutationResult).toEqual({
      shareId: 'share-abc',
      url: 'http://localhost:3000/share/m/share-abc#encoded-secret',
    });
  });

  it('calls createMessageShare with the plaintext content', async () => {
    mockCreateMessageShare.mockReturnValue({
      shareSecret: new Uint8Array([1]),
      shareBlob: new Uint8Array([2]),
    });
    mockToBase64.mockReturnValue('base64-value');
    mockFetchJson.mockResolvedValue({ shareId: 'share-1' });

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), {
      wrapper: createWrapper(),
    });

    await waitFor(async () => {
      await result.current.mutateAsync({
        messageId: 'msg-1',
        plaintextContent: 'Test message',
      });
    });

    expect(mockCreateMessageShare).toHaveBeenCalledWith('Test message');
    expect(mockCreateMessageShare).toHaveBeenCalledTimes(1);
  });

  it('calls fetchJson with base64-encoded shareBlob and messageId', async () => {
    const fakeBlob = new Uint8Array([10, 20, 30]);
    mockCreateMessageShare.mockReturnValue({
      shareSecret: new Uint8Array([1]),
      shareBlob: fakeBlob,
    });

    mockToBase64.mockImplementation((data: Uint8Array) => {
      if (data === fakeBlob) return 'blob-b64';
      return 'secret-b64';
    });

    mockFetchJson.mockResolvedValue({ shareId: 'share-xyz' });

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), {
      wrapper: createWrapper(),
    });

    await waitFor(async () => {
      await result.current.mutateAsync({
        messageId: 'msg-42',
        plaintextContent: 'Some content',
      });
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    // The first argument to fetchJson is the promise from $post
    // We verify the $post was called with the correct json payload
    const { client } = await import('@/lib/api-client');
    expect(client.api.messages.share.$post).toHaveBeenCalledWith({
      json: { messageId: 'msg-42', shareBlob: 'blob-b64' },
    });
  });

  it('propagates errors from fetchJson', async () => {
    mockCreateMessageShare.mockReturnValue({
      shareSecret: new Uint8Array([1]),
      shareBlob: new Uint8Array([2]),
    });
    mockToBase64.mockReturnValue('base64');
    mockFetchJson.mockRejectedValue(new Error('Server error'));

    const { useMessageShare } = await import('./use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-1',
        plaintextContent: 'Hello',
      })
    ).rejects.toThrow('Server error');
  });
});
