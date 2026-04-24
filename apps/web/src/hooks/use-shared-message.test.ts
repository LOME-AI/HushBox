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

interface SharePayloadContentItem {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  encryptedBlob?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  downloadUrl?: string | null;
  expiresAt?: string | null;
}

interface SharePayloadOverrides {
  shareId?: string;
  messageId?: string;
  wrappedShareKey?: string;
  contentItems?: SharePayloadContentItem[];
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
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        durationMs: null,
        downloadUrl: null,
        expiresAt: null,
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

  it('decrypts each text content item into a structured text entry in position order', async () => {
    const shareSecret = new Uint8Array([1, 1]);
    const contentKey = new Uint8Array([2, 2]);

    mockFromBase64.mockImplementation((b64) => {
      if (b64 === 'the-key') return shareSecret;
      return new TextEncoder().encode(b64);
    });
    mockOpenShare.mockReturnValue(contentKey);
    // Hook sorts by position BEFORE decrypting, so the mock is called in
    // position order (0, 1, 2) regardless of input order.
    mockDecryptTextWithContentKey
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second')
      .mockReturnValueOnce('third');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        wrappedShareKey: 'wrapped-b64',
        contentItems: [
          {
            id: 'ci-1',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
          },
          {
            id: 'ci-3',
            contentType: 'text',
            position: 2,
            encryptedBlob: 'blob-3',
          },
          {
            id: 'ci-2',
            contentType: 'text',
            position: 1,
            encryptedBlob: 'blob-2',
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

    // Structured output, ordered by `position`, using each item's decrypted text.
    expect(result.current.data?.createdAt).toBe('2026-02-01T00:00:00Z');
    expect(result.current.data?.contentItems).toEqual([
      { type: 'text', position: 0, content: 'first' },
      { type: 'text', position: 1, content: 'second' },
      { type: 'text', position: 2, content: 'third' },
    ]);
    // contentKey exposed so downstream components can decrypt media with it.
    expect(result.current.data?.contentKey).toBe(contentKey);
  });

  it('returns media items with downloadUrl, mimeType, and metadata in position order', async () => {
    const contentKey = new Uint8Array([9, 9]);
    mockOpenShare.mockReturnValue(contentKey);
    mockDecryptTextWithContentKey.mockReturnValue('caption');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        contentItems: [
          {
            id: 'ci-text',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'txt',
          },
          {
            id: 'ci-img',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 2048,
            width: 1024,
            height: 1024,
            durationMs: null,
            downloadUrl: 'https://signed.example/img?sig=a',
            expiresAt: '2026-04-19T00:05:00.000Z',
            encryptedBlob: null,
          },
          {
            id: 'ci-vid',
            contentType: 'video',
            position: 2,
            mimeType: 'video/mp4',
            sizeBytes: 4096,
            width: 1920,
            height: 1080,
            durationMs: 5000,
            downloadUrl: 'https://signed.example/vid?sig=b',
            expiresAt: '2026-04-19T00:05:00.000Z',
            encryptedBlob: null,
          },
        ],
      })
    );

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-2', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.contentItems).toEqual([
      { type: 'text', position: 0, content: 'caption' },
      {
        type: 'media',
        position: 1,
        contentItemId: 'ci-img',
        contentType: 'image',
        mimeType: 'image/png',
        sizeBytes: 2048,
        width: 1024,
        height: 1024,
        durationMs: null,
        downloadUrl: 'https://signed.example/img?sig=a',
        expiresAt: '2026-04-19T00:05:00.000Z',
      },
      {
        type: 'media',
        position: 2,
        contentItemId: 'ci-vid',
        contentType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        width: 1920,
        height: 1080,
        durationMs: 5000,
        downloadUrl: 'https://signed.example/vid?sig=b',
        expiresAt: '2026-04-19T00:05:00.000Z',
      },
    ]);
    // Text decrypt runs; media items are not symmetric-decrypted in the hook.
    expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(1);
  });

  it('skips media items that are missing downloadUrl (degraded response)', async () => {
    mockOpenShare.mockReturnValue(new Uint8Array([7]));
    mockDecryptTextWithContentKey.mockReturnValue('t');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        contentItems: [
          {
            id: 'ci-text',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob',
          },
          {
            id: 'ci-broken',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 1,
            width: 1,
            height: 1,
            durationMs: null,
            downloadUrl: null,
            expiresAt: null,
            encryptedBlob: null,
          },
        ],
      })
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { useSharedMessage } = await import('./use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-3', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.contentItems).toHaveLength(1);
    expect(result.current.data?.contentItems[0]!.type).toBe('text');
    expect(warnSpy).toHaveBeenCalledWith(
      'Skipping malformed shared media item',
      expect.objectContaining({ id: 'ci-broken' })
    );

    warnSpy.mockRestore();
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
