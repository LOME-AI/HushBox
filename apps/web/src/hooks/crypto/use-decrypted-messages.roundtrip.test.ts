import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  generateEpochKeyPair,
  generateContentKey,
  wrapContentKeyToEpoch,
  encryptContentEnvelope,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  useDecryptedMessages,
  clearDecryptedMessageCache,
  DECRYPTION_FAILED,
} from '@/hooks/crypto/use-decrypted-messages';
import { clearEpochKeyCache, setEpochKey } from '@/lib/crypto/epoch-key-cache';
import type { KeyChainResponse, MessageResponse } from '@hushbox/shared';
import type React from 'react';

/**
 * End-to-end proof that a content envelope written EXACTLY as the backend
 * writes it (fresh content key → `wrapContentKeyToEpoch` → `encryptContentEnvelope`
 * with the full location AAD — see the server's `persistEncryptedMessage`)
 * decrypts to plaintext through the migrated hook. Uses real `@hushbox/crypto`
 * (only the network + auth store are mocked) so the location reconstruction is
 * exercised for real, not against a mock.
 */

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        keychain: { $get: vi.fn(() => Promise.resolve(new Response())) },
      },
    },
  },
  // An empty keychain: `processKeyChain` verifies and caches nothing, leaving
  // the epoch private key we pre-seed into the cache untouched.
  fetchJson: vi.fn(
    (): Promise<KeyChainResponse> =>
      Promise.resolve({ epochs: [], wraps: [], currentEpoch: 1, rotationPending: false })
  ),
}));

const mockPrivateKey = new Uint8Array(32).fill(7);
vi.mock('@/lib/auth/auth', () => {
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

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'RoundTripWrapper';
  return Wrapper;
}

const CONVERSATION_ID = 'conv-rt';
const MESSAGE_ID = 'msg-rt';
const CONTENT_ITEM_ID = 'ci-rt';
const EPOCH_NUMBER = 1;

/**
 * Encode `plaintext` as the backend does, seed the epoch private key into the
 * cache, and return the wire `MessageResponse` the hook consumes. `boundSenderId`
 * is what gets bound into the AAD; `wireSenderId` (defaults to it) is what the
 * response reports — differing them proves the AAD binding is enforced.
 */
function seedMessage(
  plaintext: string,
  boundSenderId: string,
  wireSenderId?: string
): MessageResponse {
  const epoch = generateEpochKeyPair();
  const contentKey = generateContentKey();
  const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
  const blob = encryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      contentItemId: CONTENT_ITEM_ID,
      position: 0,
      epochNumber: EPOCH_NUMBER,
      senderId: boundSenderId,
    },
    { plaintext: new TextEncoder().encode(plaintext), compression: 'raw' }
  );
  setEpochKey(CONVERSATION_ID, EPOCH_NUMBER, epoch.privateKey);
  return {
    id: MESSAGE_ID,
    parentMessageId: null,
    sequenceNumber: 0,
    epochNumber: EPOCH_NUMBER,
    senderType: 'user',
    senderId: wireSenderId ?? boundSenderId,
    wrappedContentKey: toBase64(wrapped),
    batchId: 'batch-rt',
    deleted: false,
    createdAt: isoAt(TEST_DAY_START),
    contentItems: [
      {
        id: CONTENT_ITEM_ID,
        position: 0,
        contentType: 'text',
        mimeType: null,
        byteLength: null,
        width: null,
        height: null,
        durationMs: null,
        encryptedBlob: toBase64(blob),
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
  };
}

describe('useDecryptedMessages — real content-envelope round-trip', () => {
  beforeEach(() => {
    clearEpochKeyCache();
    clearDecryptedMessageCache();
  });

  it('decrypts a backend-written content envelope to plaintext', async () => {
    const plaintext = 'Round-trip through the real envelope 🎉';
    const message = seedMessage(plaintext, 'user-rt');

    const { result } = renderHook(() => useDecryptedMessages(CONVERSATION_ID, [message]), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe(plaintext);
    });
  });

  it('fails decryption when the response senderId differs from the AAD-bound senderId', async () => {
    const message = seedMessage('secret', 'real-sender', 'tampered-sender');

    const { result } = renderHook(() => useDecryptedMessages(CONVERSATION_ID, [message]), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe(DECRYPTION_FAILED);
    });
  });
});
