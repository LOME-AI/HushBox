import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { createElement, type ReactNode } from 'react';
import { useDecryptedMessages } from './use-decrypted-messages';
import type { MessageResponse } from '@hushbox/shared';
import { clearEpochKeyCache, getCacheSize } from '@/lib/epoch-key-cache';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      keys: {
        [':conversationId']: {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

const mockUnwrapEpochKey = vi.fn<(accountPrivateKey: Uint8Array, wrap: Uint8Array) => Uint8Array>();
const mockTraverseChainLink =
  vi.fn<(newerEpochPrivateKey: Uint8Array, chainLink: Uint8Array) => Uint8Array>();
const mockDecryptMessage = vi.fn<(epochPrivateKey: Uint8Array, blob: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  unwrapEpochKey: (...args: [Uint8Array, Uint8Array]) => mockUnwrapEpochKey(...args),
  traverseChainLink: (...args: [Uint8Array, Uint8Array]) => mockTraverseChainLink(...args),
  decryptMessage: (...args: [Uint8Array, Uint8Array]) => mockDecryptMessage(...args),
  verifyEpochKeyConfirmation: () => true,
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

let mockPrivateKey: Uint8Array | null = new Uint8Array([99, 98, 97]);

vi.mock('@/lib/auth', () => {
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

function createMessageResponse(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    encryptedBlob: 'base64-blob',
    senderType: 'user',
    senderId: 'user-1',
    senderDisplayName: null,
    payerId: null,
    cost: null,
    epochNumber: 1,
    sequenceNumber: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDecryptedMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    mockPrivateKey = new Uint8Array([99, 98, 97]);
    // Default fromBase64 implementation: return a Uint8Array with a simple marker
    mockFromBase64.mockImplementation((b64: string) => new TextEncoder().encode(b64));
  });

  it('returns empty array when conversationId is null', () => {
    const { result } = renderHook(() => useDecryptedMessages(null, []), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is undefined', () => {
    mockFetchJson.mockResolvedValue({ wraps: [], chainLinks: [], currentEpoch: 1 });

    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing the undefined branch
    const { result } = renderHook(() => useDecryptedMessages('conv-1', undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is empty', () => {
    mockFetchJson.mockResolvedValue({ wraps: [], chainLinks: [], currentEpoch: 1 });

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
    mockUnwrapEpochKey.mockReturnValue(epochKey);
    mockDecryptMessage.mockImplementation((_key: Uint8Array, _blob: Uint8Array) => 'Hello world');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'wrapped-key',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({
        id: 'msg-1',
        senderType: 'user',
        epochNumber: 1,
        encryptedBlob: 'blob-1',
      }),
      createMessageResponse({
        id: 'msg-2',
        senderType: 'ai',
        epochNumber: 1,
        encryptedBlob: 'blob-2',
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
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

  it('maps senderType "user" to role "user"', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

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

  it('maps senderType "ai" to role "assistant"', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ senderType: 'ai' })];

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

  it('handles multi-epoch messages with chain link traversal', async () => {
    const epoch2Key = new Uint8Array([20]);
    const epoch1Key = new Uint8Array([10]);

    mockUnwrapEpochKey.mockReturnValue(epoch2Key);
    mockTraverseChainLink.mockReturnValue(epoch1Key);
    mockDecryptMessage.mockImplementation((key: Uint8Array) =>
      key[0] === 20 ? 'epoch2-msg' : 'epoch1-msg'
    );

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [{ epochNumber: 2, chainLink: 'cl-2to1', confirmationHash: 'h' }],
      currentEpoch: 2,
    });

    const messages = [
      createMessageResponse({ id: 'old', epochNumber: 1, encryptedBlob: 'b1' }),
      createMessageResponse({ id: 'new', epochNumber: 2, encryptedBlob: 'b2' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });

    // Epoch 1 message decrypted with traversed key
    const oldMsg = result.current[0];
    if (!oldMsg) throw new Error('Expected old message');
    expect(oldMsg.content).toBe('epoch1-msg');

    // Epoch 2 message decrypted with unwrapped key
    const newMsg = result.current[1];
    if (!newMsg) throw new Error('Expected new message');
    expect(newMsg.content).toBe('epoch2-msg');

    // traverseChainLink was called with epoch2Key and chainLink bytes
    expect(mockTraverseChainLink).toHaveBeenCalledTimes(1);
    const [calledWithKey] = mockTraverseChainLink.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(calledWithKey).toBe(epoch2Key);
  });

  it('caches epoch keys and does not re-unwrap on subsequent renders', async () => {
    const epochKey = new Uint8Array([50]);
    mockUnwrapEpochKey.mockReturnValue(epochKey);
    mockDecryptMessage.mockReturnValue('cached');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

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
      expect(result.current).toHaveLength(1);
    });

    expect(mockUnwrapEpochKey).toHaveBeenCalledTimes(1);

    // Rerender with same messages
    rerender({ convId: 'conv-1', msgs: messages });

    // unwrapEpochKey should NOT be called again (cache hit)
    expect(mockUnwrapEpochKey).toHaveBeenCalledTimes(1);
    expect(getCacheSize()).toBe(1);
  });

  it('returns same reference for same input (memoized)', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('memoized');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

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

    // Rerender with same references
    rerender({ convId: 'conv-1', msgs: messages });

    expect(result.current).toBe(firstResult);
  });

  it('returns new reference for new message input', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

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

  it('shows fallback when decryptMessage throws', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('corrupted blob');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ id: 'bad-msg' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe('[decryption failed]');
    expect(msg.role).toBe('user');
  });

  it('shows fallback for missing epoch key', async () => {
    // Key chain has epoch 2 wrap but message references epoch 1 with no chain link
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([20]));
    mockDecryptMessage.mockReturnValue('epoch2-content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [], // no chain link to reach epoch 1
      currentEpoch: 2,
    });

    const messages = [
      createMessageResponse({ id: 'orphan', epochNumber: 1 }),
      createMessageResponse({ id: 'good', epochNumber: 2 }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });

    const orphan = result.current[0];
    if (!orphan) throw new Error('Expected orphan message');
    expect(orphan.content).toBe('[decryption failed: missing epoch key]');

    const good = result.current[1];
    if (!good) throw new Error('Expected good message');
    expect(good.content).toBe('epoch2-content');
  });

  it('handles corrupted wrap gracefully', async () => {
    mockUnwrapEpochKey.mockImplementation(() => {
      throw new Error('ECIES decryption failed');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'corrupted',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ epochNumber: 1 })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe('[decryption failed: missing epoch key]');
  });

  it('passes through cost from message response', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({ id: 'user-msg', senderType: 'user', cost: null }),
      createMessageResponse({ id: 'ai-msg', senderType: 'ai', cost: '0.00136000' }),
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
    expect(aiMsg.cost).toBe('0.00136000');
  });

  it('preserves senderId from the message response on successful decryption', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

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
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ id: 'ai-msg', senderId: null, senderType: 'ai' })];

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
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('corrupted');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({ id: 'bad', senderId: 'user-99', senderType: 'user' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-99');
    expect(msg.content).toBe('[decryption failed]');
  });

  it('preserves senderId on missing epoch key fallback', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([20]));

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 2,
    });

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
    expect(msg.content).toBe('[decryption failed: missing epoch key]');
  });

  it('preserves createdAt from the message response', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptMessage.mockReturnValue('time check');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ createdAt: '2026-02-01T12:00:00Z' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.createdAt).toBe('2026-02-01T12:00:00Z');
  });
});
