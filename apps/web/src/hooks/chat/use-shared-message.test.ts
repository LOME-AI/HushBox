import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  createShare,
  encryptContentEnvelope,
  generateContentKey,
  generateEpochKeyPair,
  wrapContentKeyToEpoch,
  type ContentKey,
} from '@hushbox/crypto';
import {
  fromBase64,
  toBase64,
  type ResolvedReasoningEffort,
  type SharedMessageResponse,
} from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      shared: {
        message: {
          [':shareId']: {
            $get: vi.fn(() => Promise.resolve(new Response())),
          },
        },
      },
    },
    media: {
      shared: {
        [':shareId']: {
          [':contentItemId']: {
            'download-url': {
              $get: vi.fn(() => Promise.resolve(new Response())),
            },
          },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { client, fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);
const mockPresignGet = vi.mocked(
  client.media.shared[':shareId'][':contentItemId']['download-url'].$get
);

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

const CONVERSATION_ID = '00000000-0000-7000-8000-00000000c0de';
const MESSAGE_ID = '00000000-0000-7000-8000-000000000001';
const SENDER_ID = '00000000-0000-7000-8000-000000005e11';
const EPOCH_NUMBER = 3;

interface TextItemSpec {
  id: string;
  position: number;
  text: string;
  reasoningTokens?: number | null;
  reasoningEffort?: ResolvedReasoningEffort | null;
}

interface MediaItemSpec {
  id: string;
  position: number;
  contentType: 'image' | 'audio' | 'video';
  mimeType?: string | null;
  byteLength?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

interface BuiltShare {
  /**
   * The wire shape itself, inferred from the schema that serializes it, so a
   * field added to the share read is a compile error here rather than a fixture
   * that silently stops resembling the response.
   */
  payload: SharedMessageResponse;
  /** The URL-fragment secret, base64 — what `useSharedMessage` is handed. */
  keyBase64: string;
  contentKey: ContentKey;
}

/**
 * Builds a share the way the system really produces one: the server seals each
 * text item with `encryptContentEnvelope` under the message's location tuple
 * and epoch wrap, and the sharer re-wraps only the content key under a fresh
 * share secret. A fixture built any other way proves a format nothing writes.
 */
function buildShare(
  items: { text?: TextItemSpec[]; media?: MediaItemSpec[] } = {},
  overrides: { shareId?: string; senderId?: string | null } = {}
): BuiltShare {
  const epoch = generateEpochKeyPair();
  const contentKey = generateContentKey();
  const epochWrappedContentKey = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
  // A null override seals under '' because that is what the *reader*
  // canonicalizes a null sender to — no writer ever binds '', so a real
  // scrubbed-sender blob stays undecryptable.
  const senderId = overrides.senderId === undefined ? SENDER_ID : overrides.senderId;

  const textItems = (items.text ?? []).map((item) => ({
    id: item.id,
    position: item.position,
    contentType: 'text' as const,
    mimeType: null,
    byteLength: null,
    width: null,
    height: null,
    durationMs: null,
    modelName: null,
    isSmartModel: false,
    reasoningTokens: item.reasoningTokens ?? null,
    reasoningEffort: item.reasoningEffort ?? null,
    reasoningDurationMs: null,
    encryptedBlob: toBase64(
      encryptContentEnvelope(
        contentKey,
        epochWrappedContentKey,
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          contentItemId: item.id,
          position: item.position,
          epochNumber: EPOCH_NUMBER,
          senderId: senderId ?? '',
        },
        { plaintext: new TextEncoder().encode(item.text), compression: 'raw' }
      )
    ),
  }));

  const mediaItems = (items.media ?? []).map((item) => ({
    id: item.id,
    position: item.position,
    contentType: item.contentType,
    mimeType: item.mimeType ?? null,
    byteLength: item.byteLength ?? null,
    width: item.width ?? null,
    height: item.height ?? null,
    durationMs: item.durationMs ?? null,
    modelName: null,
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    encryptedBlob: null,
  }));

  const { shareSecret, wrappedShareKey } = createShare(contentKey);

  return {
    payload: {
      shareId: overrides.shareId ?? 'share-abc',
      messageId: MESSAGE_ID,
      wrappedContentKey: toBase64(wrappedShareKey),
      createdAt: isoAt(TEST_DAY_START + 10 * HOUR_MS),
      messageCreatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
      conversationId: CONVERSATION_ID,
      epochNumber: EPOCH_NUMBER,
      senderId,
      epochWrappedContentKey: toBase64(epochWrappedContentKey),
      deleted: false,
      contentItems: [...textItems, ...mediaItems],
    },
    keyBase64: toBase64(shareSecret),
    contentKey,
  };
}

type SharedMessageData = import('@/hooks/chat/use-shared-message.js').SharedMessageData;

/** Narrows the hook's data to a live share, failing the test on anything else. */
function liveShare(
  data: SharedMessageData | undefined
): Extract<SharedMessageData, { deleted: false }> {
  if (data === undefined || data.deleted) throw new Error('expected a live share');
  return data;
}

describe('sharedMessageKeys', () => {
  it('builds the per-share detail key from the root', async () => {
    const { sharedMessageKeys } = await import('@/hooks/chat/use-shared-message.js');
    expect(sharedMessageKeys.all).toEqual(['shared-message']);
    expect(sharedMessageKeys.detail('share-abc')).toEqual(['shared-message', 'share-abc']);
  });
});

describe('useSharedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is disabled when shareId is null', async () => {
    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    renderHook(() => useSharedMessage(null, 'some-key'), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is disabled when keyBase64 is null', async () => {
    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    renderHook(() => useSharedMessage('share-123', null), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('reads the standalone share by share id', async () => {
    const share = buildShare({ text: [{ id: 'ci-1', position: 0, text: 'hello' }] });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockPresignGet).not.toHaveBeenCalled();
    expect(client.conversations.shared.message[':shareId'].$get).toHaveBeenCalledWith({
      param: { shareId: 'share-abc' },
    });
  });

  it('decrypts the server-written envelope of each text item in position order', async () => {
    const share = buildShare({
      text: [
        { id: 'ci-1', position: 0, text: 'first' },
        { id: 'ci-3', position: 2, text: 'third' },
        { id: 'ci-2', position: 1, text: 'second' },
      ],
    });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-1', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.createdAt).toBe(isoAt(TEST_DAY_START + 10 * HOUR_MS));
    expect(liveShare(result.current.data).contentItems).toEqual([
      { type: 'text', position: 0, content: 'first', reasoningTokens: null, reasoningEffort: null },
      {
        type: 'text',
        position: 1,
        content: 'second',
        reasoningTokens: null,
        reasoningEffort: null,
      },
      { type: 'text', position: 2, content: 'third', reasoningTokens: null, reasoningEffort: null },
    ]);
    expect(liveShare(result.current.data).contentKey).toEqual(share.contentKey);
  });

  it('exposes the message location tuple and epoch wrap so media decrypts under the same AAD', async () => {
    const share = buildShare({
      media: [{ id: 'ci-img', position: 0, contentType: 'image', mimeType: 'image/png' }],
    });
    mockFetchJson.mockResolvedValueOnce(share.payload).mockResolvedValueOnce({
      downloadUrl: 'https://r2.example/ci-img',
      expiresAt: isoAt(TEST_DAY_START + 17 * DAY_MS + HOUR_MS),
    });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(liveShare(result.current.data).conversationId).toBe(CONVERSATION_ID);
    expect(liveShare(result.current.data).messageId).toBe(MESSAGE_ID);
    expect(liveShare(result.current.data).epochNumber).toBe(EPOCH_NUMBER);
    expect(liveShare(result.current.data).senderId).toBe(SENDER_ID);
    expect(liveShare(result.current.data).wrappedContentKey).toEqual(
      fromBase64(share.payload.epochWrappedContentKey)
    );
  });

  it('turns a null sender into a deterministic empty-string AAD input rather than failing', async () => {
    const share = buildShare(
      { text: [{ id: 'ci-1', position: 0, text: 'still readable' }] },
      { senderId: null }
    );
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(liveShare(result.current.data).senderId).toBe('');
    expect(liveShare(result.current.data).contentItems).toEqual([
      {
        type: 'text',
        position: 0,
        content: 'still readable',
        reasoningTokens: null,
        reasoningEffort: null,
      },
    ]);
  });

  it('presigns each media content item into a media entry carrying a download URL', async () => {
    const share = buildShare({
      text: [{ id: 'ci-text', position: 0, text: 't' }],
      media: [
        {
          id: 'ci-img',
          position: 1,
          contentType: 'image',
          mimeType: 'image/png',
          byteLength: 2048,
          width: 800,
          height: 1200,
        },
      ],
    });

    // First fetchJson resolves the share read; the second resolves the media
    // presign mint for the one media item.
    mockFetchJson.mockResolvedValueOnce(share.payload).mockResolvedValueOnce({
      downloadUrl: 'https://r2.example/ci-img?sig=abc',
      expiresAt: isoAt(TEST_DAY_START + 17 * DAY_MS + HOUR_MS),
    });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-media', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockPresignGet).toHaveBeenCalledWith({
      param: { shareId: 'share-media', contentItemId: 'ci-img' },
    });

    expect(liveShare(result.current.data).contentItems).toHaveLength(2);
    const media = liveShare(result.current.data).contentItems.find((item) => item.type === 'media');
    expect(media).toMatchObject({
      type: 'media',
      position: 1,
      contentItemId: 'ci-img',
      contentType: 'image',
      mimeType: 'image/png',
      width: 800,
      height: 1200,
      durationMs: null,
      downloadUrl: 'https://r2.example/ci-img?sig=abc',
      expiresAt: isoAt(TEST_DAY_START + 17 * DAY_MS + HOUR_MS),
    });
  });

  it('skips a text content item whose encrypted blob is missing', async () => {
    const share = buildShare({ text: [{ id: 'ci-good', position: 0, text: 'kept' }] });
    share.payload.contentItems.push({
      id: 'ci-empty',
      position: 1,
      contentType: 'text',
      mimeType: null,
      byteLength: null,
      width: null,
      height: null,
      durationMs: null,
      modelName: null,
      isSmartModel: false,
      reasoningTokens: null,
      reasoningEffort: null,
      reasoningDurationMs: null,
      encryptedBlob: null,
    });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-x', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // The blob-less text item builds to null and is filtered out.
    expect(liveShare(result.current.data).contentItems).toEqual([
      {
        type: 'text',
        position: 0,
        content: 'kept',
        reasoningTokens: null,
        reasoningEffort: null,
      },
    ]);
  });

  it('defaults missing media mimeType and byteLength to empty string and zero', async () => {
    const share = buildShare({
      media: [{ id: 'ci-img2', position: 0, contentType: 'image' }],
    });
    mockFetchJson.mockResolvedValueOnce(share.payload).mockResolvedValueOnce({
      downloadUrl: 'https://r2.example/ci-img2',
      expiresAt: isoAt(TEST_DAY_START + 17 * DAY_MS + HOUR_MS),
    });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-media2', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const media = liveShare(result.current.data).contentItems.find((item) => item.type === 'media');
    expect(media).toMatchObject({ type: 'media', mimeType: '', sizeBytes: 0 });
  });

  it('propagates errors from fetchJson', async () => {
    mockFetchJson.mockRejectedValue(new Error('Not found'));

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-bad', 'key-bad'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe('Not found');
  });

  it('fails rather than rendering anything when the URL secret is wrong', async () => {
    const share = buildShare({ text: [{ id: 'ci-1', position: 0, text: 'secret' }] });
    const other = buildShare({ text: [{ id: 'ci-1', position: 0, text: 'other' }] });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-corrupt', other.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('carries the reasoning level and token count the share read serves for a text item', async () => {
    const share = buildShare({
      text: [
        {
          id: 'ci-1',
          position: 0,
          text: 'answer',
          reasoningTokens: 1204,
          reasoningEffort: 'high',
        },
      ],
    });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-reasoned', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(liveShare(result.current.data).contentItems[0]).toMatchObject({
      reasoningTokens: 1204,
      reasoningEffort: 'high',
    });
  });

  it('keeps an unrecorded reasoning level distinct from one resolved to off', async () => {
    const share = buildShare({
      text: [
        { id: 'ci-1', position: 0, text: 'none recorded' },
        {
          id: 'ci-2',
          position: 1,
          text: 'resolved off',
          reasoningTokens: 0,
          reasoningEffort: 'off',
        },
      ],
    });
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-off', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(liveShare(result.current.data).contentItems[0]).toMatchObject({
      reasoningTokens: null,
      reasoningEffort: null,
    });
    expect(liveShare(result.current.data).contentItems[1]).toMatchObject({
      reasoningTokens: 0,
      reasoningEffort: 'off',
    });
  });

  it('fails rather than returning garbage when the blob was sealed at another location', async () => {
    const share = buildShare({ text: [{ id: 'ci-1', position: 0, text: 'bound' }] });
    // Relocating the item is exactly what the envelope AAD exists to refuse.
    share.payload.contentItems[0]!.position = 7;
    mockFetchJson.mockResolvedValue(share.payload);

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-moved', share.keyBase64), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  describe('a share whose message is deleted', () => {
    function deletedShare(): BuiltShare {
      const share = buildShare({}, { senderId: null });
      return { ...share, payload: { ...share.payload, deleted: true, contentItems: [] } };
    }

    it('returns deleted: true', async () => {
      const share = deletedShare();
      mockFetchJson.mockResolvedValue(share.payload);

      const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
      const { result } = renderHook(() => useSharedMessage('share-gone', share.keyBase64), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(result.current.data?.deleted).toBe(true);
    });

    it('decrypts nothing, so a secret that cannot open the share still reads as deleted', async () => {
      const share = deletedShare();
      const unrelated = buildShare();
      mockFetchJson.mockResolvedValue(share.payload);

      const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
      const { result } = renderHook(() => useSharedMessage('share-gone', unrelated.keyBase64), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(result.current.data?.deleted).toBe(true);
      expect(mockPresignGet).not.toHaveBeenCalled();
    });

    it('returns deleted: false for a live share', async () => {
      const share = buildShare({ text: [{ id: 'ci-1', position: 0, text: 'here' }] });
      mockFetchJson.mockResolvedValue(share.payload);

      const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
      const { result } = renderHook(() => useSharedMessage('share-live', share.keyBase64), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      expect(result.current.data?.deleted).toBe(false);
    });
  });
});
