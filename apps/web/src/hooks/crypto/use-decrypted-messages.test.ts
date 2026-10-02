import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, type ReactNode } from 'react';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  useDecryptedMessages,
  clearDecryptedMessageCache,
  isDecryptionFailure,
  DECRYPTION_FAILED,
  DECRYPTION_FAILED_MISSING_EPOCH_KEY,
} from '@/hooks/crypto/use-decrypted-messages';
import { clearEpochKeyCache, getCacheSize } from '@/lib/crypto/epoch-key-cache';
import { fetchJson } from '@/lib/api-client';
import type { Message } from '@/lib/api/api';
import type { KeyChainVerdict } from '@hushbox/crypto';
import type { KeyChainResponse, MessageResponse, ResolvedReasoningEffort } from '@hushbox/shared';
import type React from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        keychain: {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

const mockFetchJson = vi.mocked(fetchJson);

/**
 * The keychain verifier is the crypto package's, proven there. Here each test
 * states which served epochs verified, and to which key, through
 * `mockVerifiedKey`; the stub unwraps and walks nothing.
 */
const mockVerifiedKey = vi.fn<(epochNumber: number) => Uint8Array | undefined>();
const mockVerifyKeyChain = vi.fn((keyChain: KeyChainResponse): KeyChainVerdict => {
  const keys = new Map<number, Uint8Array>();
  for (const record of keyChain.epochs) {
    const key = mockVerifiedKey(record.epochNumber);
    if (key !== undefined) keys.set(record.epochNumber, key);
  }
  return { epochs: new Map(), rotation: 'ok', lastGoodEpoch: null, keys };
});
const mockUnwrapContentKey =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockDecryptEnvelopeText = vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  verifyKeyChain: (keyChain: KeyChainResponse) => mockVerifyKeyChain(keyChain),
  asEpochPrivateKey: (bytes: Uint8Array) => bytes,
  unwrapContentKeyFromEpoch: (...args: [Uint8Array, Uint8Array]) => mockUnwrapContentKey(...args),
  // The real fn returns UTF-8 plaintext bytes; the hook decodes them. The mock
  // impl yields a string (the expected plaintext), encoded here so call sites
  // stay `.mockReturnValue('...')`. Reads (contentKey, blob) — the wrapped key
  // and location args are AAD-only and unused by the mock.
  decryptContentEnvelope: (
    contentKey: Uint8Array,
    _wrapped: Uint8Array,
    _location: unknown,
    blob: Uint8Array
  ) => new TextEncoder().encode(mockDecryptEnvelopeText(contentKey, blob)),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

let mockPrivateKey: Uint8Array | null = new Uint8Array([99, 98, 97]);

vi.mock('@/lib/auth/auth', () => {
  // Zustand hook: called as function returns state, also has getState/subscribe
  const store = Object.assign(
    (selector?: (s: { privateKey: Uint8Array | null }) => unknown) => {
      const state = { privateKey: mockPrivateKey };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ privateKey: mockPrivateKey }),
      setState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      destroy: vi.fn(),
    }
  );
  return { useAuthStore: store };
});

/** A keychain serving epochs 1 through `currentEpoch`, one direct wrap each. */
function keyChainAt(currentEpoch: number): KeyChainResponse {
  const epochNumbers = Array.from({ length: currentEpoch }, (_, index) => index + 1);
  return {
    epochs: epochNumbers.map((epochNumber) => ({
      epochNumber,
      epochPublicKey: `pub-${String(epochNumber)}`,
      confirmationHash: `hash-${String(epochNumber)}`,
      previousEpochNumber: epochNumber === 1 ? null : epochNumber - 1,
      chainLink: epochNumber === 1 ? null : `link-${String(epochNumber)}`,
    })),
    wraps: epochNumbers.map((epochNumber) => ({
      epochNumber,
      wrap: `wrap-${String(epochNumber)}`,
    })),
    currentEpoch,
    rotationPending: false,
  };
}

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

interface MessageResponseOverrides extends Partial<Omit<MessageResponse, 'contentItems'>> {
  /** Shortcut: base64 encrypted blob for the single default text content item. */
  encryptedBlob?: string;
  /** Shortcut: model_name on the default text content item (AI messages). */
  modelName?: string | null;
  /** Shortcut: cost on the default text content item. */
  cost?: string | null;
  contentItems?: MessageResponse['contentItems'];
}

function createMessageResponse(overrides: MessageResponseOverrides = {}): MessageResponse {
  const {
    encryptedBlob: encryptedBlobOverride,
    modelName: modelNameOverride,
    cost: costOverride,
    contentItems: contentItemsOverride,
    ...rest
  } = overrides;

  return {
    id: 'msg-1',
    parentMessageId: null,
    sequenceNumber: 0,
    epochNumber: 1,
    senderType: 'user',
    senderId: 'user-1',
    wrappedContentKey: 'base64-wrapped',
    batchId: 'batch-1',
    deleted: false,
    createdAt: isoAt(TEST_DAY_START),
    contentItems: contentItemsOverride ?? [
      {
        id: `${rest.id ?? 'msg-1'}-ci`,
        position: 0,
        contentType: 'text',
        mimeType: null,
        byteLength: null,
        width: null,
        height: null,
        durationMs: null,
        encryptedBlob: encryptedBlobOverride ?? 'base64-blob',
        modelName: modelNameOverride ?? null,
        cost: costOverride ?? null,
        isSmartModel: false,
        reasoningTokens: null,
        reasoningEffort: null,
        reasoningDurationMs: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
    ...rest,
  };
}

/**
 * Renders one settled assistant message whose single variable is the reasoning
 * level its content item carries: a rung, `off`, or none recorded at all.
 */
function renderMessageWithLevel(
  reasoningEffort?: ResolvedReasoningEffort
): ReturnType<typeof renderHook<Message[], unknown>> {
  mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
  mockDecryptEnvelopeText.mockReturnValue('content');
  mockFetchJson.mockResolvedValue(keyChainAt(1));

  const base = createMessageResponse({ id: 'ai-msg', senderType: 'assistant' });
  const message = {
    ...base,
    contentItems: base.contentItems.map((item) => ({
      ...item,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })),
  };

  return renderHook(() => useDecryptedMessages('conv-1', [message]), {
    wrapper: createWrapper(),
  });
}

describe('useDecryptedMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    clearDecryptedMessageCache();
    mockPrivateKey = new Uint8Array([99, 98, 97]);
    mockFromBase64.mockImplementation((b64: string) => new TextEncoder().encode(b64));
    mockUnwrapContentKey.mockImplementation(
      (epochPriv: Uint8Array, _wrapped: Uint8Array) => epochPriv
    );
    mockDecryptEnvelopeText.mockImplementation(
      (_contentKey: Uint8Array, _ciphertext: Uint8Array) => ''
    );
  });

  it('returns empty array when conversationId is null', () => {
    const { result } = renderHook(() => useDecryptedMessages(null, []), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is undefined', () => {
    mockFetchJson.mockResolvedValue(keyChainAt(1));

    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing the undefined branch
    const { result } = renderHook(() => useDecryptedMessages('conv-1', undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is empty', () => {
    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const { result } = renderHook(() => useDecryptedMessages('conv-1', []), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when privateKey is null', () => {
    mockPrivateKey = null;

    const messages = [createMessageResponse()];
    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('decrypts single-epoch messages correctly', async () => {
    const epochKey = new Uint8Array([10, 20, 30]);
    mockVerifiedKey.mockReturnValue(epochKey);
    mockDecryptEnvelopeText.mockImplementation(
      (_key: Uint8Array, _blob: Uint8Array) => 'Hello world'
    );

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({
        id: 'msg-1',
        senderType: 'user',
        epochNumber: 1,
        encryptedBlob: 'blob-1',
      }),
      createMessageResponse({
        id: 'msg-2',
        senderType: 'assistant',
        epochNumber: 1,
        encryptedBlob: 'blob-2',
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('Hello world');
    });

    const first = result.current[0];
    if (!first) throw new Error('Expected message at index 0');
    expect(first.role).toBe('user');
    expect(first.content).toBe('Hello world');
    expect(first.id).toBe('msg-1');
    expect(first.conversationId).toBe('conv-1');

    const second = result.current[1];
    if (!second) throw new Error('Expected message at index 1');
    expect(second.role).toBe('assistant');
    expect(second.content).toBe('Hello world');
    expect(second.id).toBe('msg-2');
  });

  it('extracts valid media items, flags smart-model, and skips malformed media', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([10, 20, 30]));
    mockDecryptEnvelopeText.mockImplementation((_key: Uint8Array, _blob: Uint8Array) => 'body');
    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({
        id: 'msg-media',
        senderType: 'assistant',
        epochNumber: 1,
        contentItems: [
          {
            id: 'ci-text',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
            mimeType: null,
            byteLength: null,
            width: null,
            height: null,
            durationMs: null,
            modelName: null,
            cost: null,
            isSmartModel: true,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
          {
            id: 'ci-image',
            contentType: 'image',
            position: 1,
            encryptedBlob: null,
            mimeType: 'image/png',
            byteLength: 2048,
            width: 32,
            height: 24,
            durationMs: null,
            modelName: null,
            cost: null,
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
          {
            id: 'ci-bad',
            contentType: 'image',
            position: 2,
            encryptedBlob: null,
            mimeType: null,
            byteLength: null,
            width: null,
            height: null,
            durationMs: null,
            modelName: null,
            cost: null,
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('body');
    });

    const msg = result.current[0]!;
    expect(msg.isSmartModel).toBe(true);
    expect(msg.mediaItems).toHaveLength(1);
    expect(msg.mediaItems?.[0]?.id).toBe('ci-image');
  });

  it('invalidates the key chain when a message references a newer epoch', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'TestWrapper';

    // The message epoch (2) exceeds the cached currentEpoch (1), so the effect
    // must invalidate the key chain to pull the missing rotation.
    const messages = [createMessageResponse({ id: 'future', epochNumber: 2, encryptedBlob: 'b' })];

    renderHook(() => useDecryptedMessages('conv-1', messages), { wrapper: Wrapper });

    await waitFor(() => {
      // keyKeys.chain('conv-1') === ['keys', 'conv-1']
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['keys', 'conv-1'] });
    });
  });

  it('maps senderType "user" to role "user"', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ senderType: 'user' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.role).toBe('user');
  });

  it('maps senderType "assistant" to role "assistant"', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ senderType: 'assistant' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.role).toBe('assistant');
  });

  it('maps senderType "system" to role "assistant"', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('system content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ senderType: 'system' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.role).toBe('assistant');
  });

  it('decrypts each message under the verified key of its own epoch', async () => {
    const epoch2Key = new Uint8Array([20]);
    const epoch1Key = new Uint8Array([10]);

    mockVerifiedKey.mockImplementation((epochNumber) =>
      epochNumber === 2 ? epoch2Key : epoch1Key
    );
    mockDecryptEnvelopeText.mockImplementation((key: Uint8Array) =>
      key[0] === 20 ? 'epoch2-msg' : 'epoch1-msg'
    );

    mockFetchJson.mockResolvedValue(keyChainAt(2));

    const messages = [
      createMessageResponse({ id: 'old', epochNumber: 1, encryptedBlob: 'b1' }),
      createMessageResponse({ id: 'new', epochNumber: 2, encryptedBlob: 'b2' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('epoch1-msg');
    });

    const oldMsg = result.current[0];
    if (!oldMsg) throw new Error('Expected old message');
    expect(oldMsg.content).toBe('epoch1-msg');

    const newMsg = result.current[1];
    if (!newMsg) throw new Error('Expected new message');
    expect(newMsg.content).toBe('epoch2-msg');
  });

  it('caches epoch keys and does not re-verify on subsequent renders', async () => {
    const epochKey = new Uint8Array([50]);
    mockVerifiedKey.mockReturnValue(epochKey);
    mockDecryptEnvelopeText.mockReturnValue('cached');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ epochNumber: 1 })];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('cached');
    });

    expect(mockVerifyKeyChain).toHaveBeenCalledTimes(1);

    rerender({ convId: 'conv-1', msgs: messages });

    // The keychain is verified once; a re-render reads the cache.
    expect(mockVerifyKeyChain).toHaveBeenCalledTimes(1);
    expect(getCacheSize()).toBe(1);
  });

  it('returns same reference for same input (memoized)', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('memoized');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse()];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const firstResult = result.current;

    rerender({ convId: 'conv-1', msgs: messages });

    expect(result.current).toBe(firstResult);
  });

  it('returns new reference for new message input', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages1 = [createMessageResponse({ id: 'msg-1' })];
    const messages2 = [createMessageResponse({ id: 'msg-2' })];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages1 },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const firstResult = result.current;

    rerender({ convId: 'conv-1', msgs: messages2 });

    await waitFor(() => {
      expect(result.current).not.toBe(firstResult);
    });
  });

  it('shows fallback when decryptTextFromEpoch throws', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockImplementation(() => {
      throw new Error('corrupted blob');
    });

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ id: 'bad-msg' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe(DECRYPTION_FAILED);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe(DECRYPTION_FAILED);
    expect(msg.role).toBe('user');
  });

  it('shows fallback for missing epoch key', async () => {
    // Only epoch 2's key verified; the message references epoch 1.
    mockVerifiedKey.mockImplementation((epochNumber) =>
      epochNumber === 2 ? new Uint8Array([20]) : undefined
    );
    mockDecryptEnvelopeText.mockReturnValue('epoch2-content');

    mockFetchJson.mockResolvedValue(keyChainAt(2));

    const messages = [
      createMessageResponse({ id: 'orphan', epochNumber: 1 }),
      createMessageResponse({ id: 'good', epochNumber: 2 }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[1]?.content).toBe('epoch2-content');
    });

    const orphan = result.current[0];
    if (!orphan) throw new Error('Expected orphan message');
    expect(orphan.content).toBe(DECRYPTION_FAILED_MISSING_EPOCH_KEY);

    const good = result.current[1];
    if (!good) throw new Error('Expected good message');
    expect(good.content).toBe('epoch2-content');
  });

  it('shows the missing-key fallback when the epoch key did not verify', async () => {
    // A wrap that failed verification yields no key.
    mockVerifiedKey.mockReset();

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ epochNumber: 1 })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe(DECRYPTION_FAILED_MISSING_EPOCH_KEY);
  });

  it('passes through cost from message response', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({ id: 'user-msg', senderType: 'user', cost: null }),
      createMessageResponse({ id: 'ai-msg', senderType: 'assistant', cost: '1360000' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });

    const userMsg = result.current[0];
    if (!userMsg) throw new Error('Expected user message');
    expect(userMsg.cost).toBeUndefined();

    const aiMsg = result.current[1];
    if (!aiMsg) throw new Error('Expected AI message');
    expect(aiMsg.cost).toBe('1360000');
  });

  it('populates reasoningTokens from the content items (reload parity with the live count)', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const base = createMessageResponse({ id: 'ai-msg', senderType: 'assistant' });
    const messages = [
      {
        ...base,
        contentItems: base.contentItems.map((item) => ({ ...item, reasoningTokens: 1204 })),
      },
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    expect(result.current[0]?.reasoningTokens).toBe(1204);
  });

  it('leaves reasoningTokens absent for a zero-reasoning message', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const base = createMessageResponse({ id: 'ai-msg', senderType: 'assistant' });
    const messages = [
      base,
      {
        ...createMessageResponse({ id: 'ai-msg-zero', senderType: 'assistant' }),
        contentItems: createMessageResponse({ id: 'ai-msg-zero' }).contentItems.map((item) => ({
          ...item,
          reasoningTokens: 0,
        })),
      },
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });

    expect(result.current[0]?.reasoningTokens).toBeUndefined();
    expect(result.current[1]?.reasoningTokens).toBeUndefined();
  });

  it('populates reasoningEffort from the content items', async () => {
    const { result } = renderMessageWithLevel('high');

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    expect(result.current[0]?.reasoningEffort).toBe('high');
  });

  it('keeps an off level on the message rather than dropping it', async () => {
    const { result } = renderMessageWithLevel('off');

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    expect(result.current[0]?.reasoningEffort).toBe('off');
  });

  it('leaves reasoningEffort absent when no content item recorded one', async () => {
    const { result } = renderMessageWithLevel();

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    expect(result.current[0]?.reasoningEffort).toBeUndefined();
  });

  it('sums multiple content-item costs as bigint NanoUSD', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({
        id: 'ai-msg',
        senderType: 'assistant',
        contentItems: [
          {
            id: 'ci-1',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
            mimeType: null,
            byteLength: null,
            width: null,
            height: null,
            durationMs: null,
            modelName: 'model-a',
            cost: '1360000',
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
          {
            id: 'ci-2',
            contentType: 'text',
            position: 1,
            encryptedBlob: 'blob-2',
            mimeType: null,
            byteLength: null,
            width: null,
            height: null,
            durationMs: null,
            modelName: null,
            cost: '640000',
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const aiMsg = result.current[0];
    if (!aiMsg) throw new Error('Expected AI message');
    // 1_360_000 + 640_000 = 2_000_000 nano, summed as bigint (no float drift).
    expect(aiMsg.cost).toBe('2000000');
    expect(aiMsg.modelName).toBe('model-a');
  });

  it('leaves message cost null (not "0") when no content item has a cost', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse({ id: 'ai-msg', senderType: 'assistant', cost: null })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const aiMsg = result.current[0];
    if (!aiMsg) throw new Error('Expected AI message');
    expect(aiMsg.cost).toBeUndefined();
  });

  it('surfaces the smart-model flag when any content item is smart', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({
        id: 'ai-msg',
        senderType: 'assistant',
        contentItems: [
          {
            id: 'ci-1',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
            mimeType: null,
            byteLength: null,
            width: null,
            height: null,
            durationMs: null,
            modelName: 'router-model',
            cost: '1360000',
            isSmartModel: true,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const aiMsg = result.current[0];
    if (!aiMsg) throw new Error('Expected AI message');
    expect(aiMsg.isSmartModel).toBe(true);
    expect(aiMsg.modelName).toBe('router-model');
  });

  it('preserves senderId from the message response on successful decryption', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({ id: 'msg-with-sender', senderId: 'user-42', senderType: 'user' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-42');
  });

  it('omits senderId when null in the message response', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({ id: 'ai-msg', senderId: null, senderType: 'assistant' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBeUndefined();
  });

  it('preserves senderId on decryption failure fallback', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockImplementation(() => {
      throw new Error('corrupted');
    });

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [
      createMessageResponse({ id: 'bad', senderId: 'user-99', senderType: 'user' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe(DECRYPTION_FAILED);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-99');
    expect(msg.content).toBe(DECRYPTION_FAILED);
  });

  it('preserves senderId on missing epoch key fallback', async () => {
    mockVerifiedKey.mockImplementation((epochNumber) =>
      epochNumber === 2 ? new Uint8Array([20]) : undefined
    );

    mockFetchJson.mockResolvedValue(keyChainAt(2));

    const messages = [createMessageResponse({ id: 'orphan', epochNumber: 1, senderId: 'user-77' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-77');
    expect(msg.content).toBe(DECRYPTION_FAILED_MISSING_EPOCH_KEY);
  });

  it('leaves createdAt empty, the history wire carrying no message timestamp', async () => {
    mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptEnvelopeText.mockReturnValue('time check');

    mockFetchJson.mockResolvedValue(keyChainAt(1));

    const messages = [createMessageResponse()];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.createdAt).toBe('');
  });

  describe('per-message decrypted-content cache', () => {
    it('decrypts only the new message when one is appended', async () => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptEnvelopeText.mockReturnValue('content');

      mockFetchJson.mockResolvedValue(keyChainAt(1));

      const initial = [
        createMessageResponse({ id: 'm1', epochNumber: 1, encryptedBlob: 'b1' }),
        createMessageResponse({ id: 'm2', epochNumber: 1, encryptedBlob: 'b2' }),
      ];

      const { result, rerender } = renderHook(
        ({ msgs }: { msgs: MessageResponse[] }) => useDecryptedMessages('conv-cache', msgs),
        {
          initialProps: { msgs: initial },
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => {
        expect(result.current[1]?.content).toBe('content');
      });

      expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(2);
      mockDecryptEnvelopeText.mockClear();

      // Realtime invalidation produces a NEW array reference with one new message.
      const withNew = [
        createMessageResponse({ id: 'm1', epochNumber: 1, encryptedBlob: 'b1' }),
        createMessageResponse({ id: 'm2', epochNumber: 1, encryptedBlob: 'b2' }),
        createMessageResponse({ id: 'm3', epochNumber: 1, encryptedBlob: 'b3' }),
      ];
      rerender({ msgs: withNew });

      await waitFor(() => {
        expect(result.current[2]?.content).toBe('content');
      });

      // Only the new message m3 is decrypted; m1/m2 reuse cached plaintext.
      expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(1);
    });

    it('re-decrypts a message when its epoch changes', async () => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptEnvelopeText.mockReturnValue('content');

      mockFetchJson.mockResolvedValue(keyChainAt(2));

      const epoch1 = [createMessageResponse({ id: 'rot', epochNumber: 1, encryptedBlob: 'b' })];

      const { result, rerender } = renderHook(
        ({ msgs }: { msgs: MessageResponse[] }) => useDecryptedMessages('conv-rotate', msgs),
        {
          initialProps: { msgs: epoch1 },
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('content');
      });

      expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(1);
      mockDecryptEnvelopeText.mockClear();

      // Same message id, rotated to a new epoch — cache entry must invalidate.
      const epoch2 = [createMessageResponse({ id: 'rot', epochNumber: 2, encryptedBlob: 'b' })];
      rerender({ msgs: epoch2 });

      // The rotated message is a cache miss (epoch changed), so it re-decrypts.
      await waitFor(() => {
        expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(1);
      });
      expect(result.current[0]?.epochNumber).toBe(2);
    });

    it('does not double-decrypt under StrictMode', async () => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptEnvelopeText.mockReturnValue('content');

      mockFetchJson.mockResolvedValue(keyChainAt(1));

      const messages = [createMessageResponse({ id: 'sm', epochNumber: 1, encryptedBlob: 'b' })];

      function StrictWrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
        const Base = createWrapper();
        return createElement(StrictMode, null, createElement(Base, null, children));
      }

      const { result } = renderHook(() => useDecryptedMessages('conv-strict', messages), {
        wrapper: StrictWrapper,
      });

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('content');
      });

      const msg = result.current[0];
      if (!msg) throw new Error('Expected message');
      expect(msg.content).toBe('content');

      // StrictMode double-invokes render; the cache must collapse the side
      // effect so decryption runs once, not twice.
      expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(1);
    });
  });

  describe('a message whose sender deleted their account', () => {
    beforeEach(() => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([1]));
      mockFetchJson.mockResolvedValue(keyChainAt(1));
    });

    function deletedMessageResponse(id: string): MessageResponse {
      return createMessageResponse({ id, senderId: null, deleted: true, contentItems: [] });
    }

    it('carries empty content and the deleted flag', async () => {
      const messages = [
        createMessageResponse({ id: 'live', encryptedBlob: 'b' }),
        deletedMessageResponse('gone'),
      ];
      mockDecryptEnvelopeText.mockReturnValue('still here');

      const { result } = renderHook(() => useDecryptedMessages('conv-deleted', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('still here');
      });
      expect(result.current[1]).toMatchObject({ id: 'gone', content: '', deleted: true });
    });

    it('attempts no decryption', async () => {
      const messages = [
        createMessageResponse({ id: 'live', encryptedBlob: 'b' }),
        deletedMessageResponse('gone'),
      ];
      mockDecryptEnvelopeText.mockReturnValue('still here');

      const { result } = renderHook(() => useDecryptedMessages('conv-deleted', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('still here');
      });
      expect(mockUnwrapContentKey).toHaveBeenCalledTimes(1);
      expect(mockDecryptEnvelopeText).toHaveBeenCalledTimes(1);
    });

    it('ignores plaintext the cache still holds for the same message', async () => {
      mockDecryptEnvelopeText.mockReturnValue('words from before the deletion');

      const { result, rerender } = renderHook(
        ({ msgs }: { msgs: MessageResponse[] }) => useDecryptedMessages('conv-deleted', msgs),
        {
          initialProps: { msgs: [createMessageResponse({ id: 'm1', encryptedBlob: 'b' })] },
          wrapper: createWrapper(),
        }
      );
      await waitFor(() => {
        expect(result.current[0]?.content).toBe('words from before the deletion');
      });

      rerender({ msgs: [deletedMessageResponse('m1')] });

      await waitFor(() => {
        expect(result.current[0]?.deleted).toBe(true);
      });
      expect(result.current[0]?.content).toBe('');
    });

    it('leaves the deleted flag off a live message', async () => {
      mockDecryptEnvelopeText.mockReturnValue('live words');
      const messages = [createMessageResponse({ id: 'live', encryptedBlob: 'b' })];

      const { result } = renderHook(() => useDecryptedMessages('conv-deleted', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('live words');
      });
      expect(result.current[0]).not.toHaveProperty('deleted');
    });
  });

  describe('stale epoch key refetch', () => {
    beforeEach(() => {
      mockFetchJson.mockReset();
    });

    it('refetches keys when a message epoch exceeds the cached currentEpoch', async () => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([10]));
      mockDecryptEnvelopeText.mockReturnValue('decrypted-content');

      mockFetchJson.mockResolvedValueOnce(keyChainAt(1)).mockResolvedValueOnce(keyChainAt(2));

      const messages = [
        createMessageResponse({ id: 'msg-1', epochNumber: 1 }),
        createMessageResponse({ id: 'msg-2', epochNumber: 2 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-1', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        const msg2 = result.current.find((m) => m.id === 'msg-2');
        expect(msg2?.content).toBe('decrypted-content');
      });

      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it('does not refetch when missing epoch keys are within currentEpoch', async () => {
      mockVerifiedKey.mockImplementation((epochNumber) =>
        epochNumber === 2 ? new Uint8Array([20]) : undefined
      );
      mockDecryptEnvelopeText.mockReturnValue('epoch2-content');

      mockFetchJson.mockResolvedValue(keyChainAt(2));

      const messages = [
        createMessageResponse({ id: 'orphan', epochNumber: 1 }),
        createMessageResponse({ id: 'good', epochNumber: 2 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-2', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current).toHaveLength(2);
      });

      const orphan = result.current[0];
      if (!orphan) throw new Error('Expected orphan message');
      expect(orphan.content).toBe(DECRYPTION_FAILED_MISSING_EPOCH_KEY);

      // Only one fetch — no refetch triggered since epoch 1 <= currentEpoch 2
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('does not refetch more than once for the same stale currentEpoch', async () => {
      mockVerifiedKey.mockReturnValue(new Uint8Array([10]));
      mockDecryptEnvelopeText.mockReturnValue('content');

      // Server always returns currentEpoch: 1 (simulates delayed rotation)
      mockFetchJson.mockResolvedValue(keyChainAt(1));

      const messages = [
        createMessageResponse({ id: 'msg-1', epochNumber: 1 }),
        createMessageResponse({ id: 'msg-2', epochNumber: 3 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-3', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current).toHaveLength(2);
      });

      // Wait a tick to ensure no further refetches are triggered
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      // Initial fetch + exactly one refetch = 2 calls total, NOT more
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });
});

describe('decryption-failure marker', () => {
  it('pins the wording shown for a message whose ciphertext cannot be opened', () => {
    expect(DECRYPTION_FAILED).toBe('[decryption failed]');
  });

  it('pins the wording shown when no epoch key is available', () => {
    expect(DECRYPTION_FAILED_MISSING_EPOCH_KEY).toBe('[decryption failed: missing epoch key]');
  });

  it('recognises every marker the hook substitutes', () => {
    expect(isDecryptionFailure(DECRYPTION_FAILED)).toBe(true);
    expect(isDecryptionFailure(DECRYPTION_FAILED_MISSING_EPOCH_KEY)).toBe(true);
  });

  it('does not recognise decrypted plaintext that merely mentions the failure', () => {
    expect(isDecryptionFailure('the decryption failed on my other device')).toBe(false);
  });
});
