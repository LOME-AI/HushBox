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

const mockOpenShare = vi.fn<(secret: Uint8Array, wrapped: Uint8Array) => Uint8Array>();
const mockDecryptTextWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  openShare: (secret: Uint8Array, wrapped: Uint8Array) => mockOpenShare(secret, wrapped),
  decryptTextWithContentKey: (contentKey: Uint8Array, ciphertext: Uint8Array) =>
    mockDecryptTextWithContentKey(contentKey, ciphertext),
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

interface SharePayloadOverrides {
  shareId?: string;
  messageId?: string;
  wrappedShareKey?: string;
  contentItems?: {
    id: string;
    contentType: 'text' | 'image' | 'audio' | 'video';
    position: number;
    encryptedBlob?: string | null;
    storageKey?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
  }[];
  createdAt?: string;
}

function sharePayload(overrides: SharePayloadOverrides = {}): Record<string, unknown> {
  return {
    shareId: overrides.shareId ?? 'share-id',
    messageId: overrides.messageId ?? 'msg-id',
    wrappedShareKey: overrides.wrappedShareKey ?? 'wrapped-share-key-b64',
    contentItems: overrides.contentItems ?? [
      {
        id: 'ci-1',
        contentType: 'text',
        position: 0,
        encryptedBlob: 'ciphertext-b64',
        storageKey: null,
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        durationMs: null,
      },
    ],
    createdAt: overrides.createdAt ?? '2026-01-15T10:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSharedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromBase64.mockImplementation((b64) => new TextEncoder().encode(b64));
    mockOpenShare.mockImplementation((_secret, wrapped) => wrapped);
    mockDecryptTextWithContentKey.mockReturnValue('');
  });

  it('is disabled when shareId is null', async () => {
    const { useSharedMessage } = await import('./use-shared-message.js');
    renderHook(() => useSharedMessage(null, 'some-key'), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is disabled when keyBase64 is null', async () => {
    const { useSharedMessage } = await import('./use-shared-message.js');
    renderHook(() => useSharedMessage('share-123', null), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('calls fetchJson with the correct shareId param', async () => {
    mockFetchJson.mockResolvedValue(sharePayload({ shareId: 'share-abc' }));
    mockDecryptTextWithContentKey.mockReturnValue('hello');

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
  });

  it('unwraps the share key, decrypts each text content item, and joins them', async () => {
    const shareSecret = new Uint8Array([1, 1]);
    const contentKey = new Uint8Array([2, 2]);

    mockFromBase64.mockImplementation((b64) => {
      if (b64 === 'the-key') return shareSecret;
      return new TextEncoder().encode(b64);
    });
    mockOpenShare.mockReturnValue(contentKey);
    mockDecryptTextWithContentKey
      .mockReturnValueOnce('first')
      .mockReturnValueOnce(' second')
      .mockReturnValueOnce(' third');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        wrappedShareKey: 'wrapped-b64',
        contentItems: [
          {
            id: 'ci-1',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
            storageKey: null,
            mimeType: null,
            sizeBytes: null,
            width: null,
            height: null,
            durationMs: null,
          },
          {
            id: 'ci-2',
            contentType: 'text',
            position: 1,
            encryptedBlob: 'blob-2',
            storageKey: null,
            mimeType: null,
            sizeBytes: null,
            width: null,
            height: null,
            durationMs: null,
          },
          {
            id: 'ci-3',
            contentType: 'text',
            position: 2,
            encryptedBlob: 'blob-3',
            storageKey: null,
            mimeType: null,
            sizeBytes: null,
            width: null,
            height: null,
            durationMs: null,
          },
        ],
        createdAt: '2026-02-01T00:00:00Z',
      })
    );

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-1', 'the-key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // openShare called once with the shareSecret from the URL fragment
    expect(mockOpenShare).toHaveBeenCalledTimes(1);
    const [openSecret] = mockOpenShare.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(openSecret).toBe(shareSecret);

    // decryptTextWithContentKey called once per content item with the same contentKey
    expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(3);
    const firstCallKey = mockDecryptTextWithContentKey.mock.calls[0]![0];
    expect(firstCallKey).toBe(contentKey);

    expect(result.current.data).toEqual({
      content: 'first second third',
      createdAt: '2026-02-01T00:00:00Z',
    });
  });

  it('propagates errors from fetchJson', async () => {
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

  it('propagates errors from openShare when the share secret is wrong', async () => {
    mockFetchJson.mockResolvedValue(sharePayload());
    mockOpenShare.mockImplementation(() => {
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
