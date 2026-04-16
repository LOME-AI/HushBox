import { describe, it, expect, vi } from 'vitest';

// Mock modules that trigger env validation on import
vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));
vi.mock('@/lib/sse-client', () => ({}));
vi.mock('@/hooks/use-chat-stream', () => ({}));
vi.mock('@/hooks/chat', () => ({
  DECRYPTING_TITLE: 'Decrypting...',
}));
vi.mock('@/hooks/use-chat-page', () => ({}));
vi.mock('@/hooks/use-optimistic-messages', () => ({}));
vi.mock('@/hooks/use-decrypted-messages', () => ({}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/forks', () => ({}));
vi.mock('@/hooks/use-fork-messages', () => ({}));
vi.mock('@/hooks/billing', () => ({}));
vi.mock('@/stores/pending-chat', () => ({}));
vi.mock('@/stores/model', () => ({}));
vi.mock('@/stores/search', () => ({}));
vi.mock('@/stores/chat-error', () => ({}));
vi.mock('@/lib/auth', () => ({}));
vi.mock('@/lib/epoch-key-cache', () => ({}));
vi.mock('@/lib/chat-messages', () => ({}));
vi.mock('@/lib/multi-model-stream', () => ({}));
vi.mock('@/lib/chat-regeneration', () => ({}));
vi.mock('@/stores/streaming-activity', () => ({}));
vi.mock('@hushbox/crypto', () => ({}));

import {
  shouldRedirect,
  computeRenderState,
  pruneMessagesAfterTarget,
  mergeMessages,
  DECRYPTING_TITLE,
} from './use-authenticated-chat';

function makeMessage(
  id: string,
  role: 'user' | 'assistant' = 'user'
): {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
} {
  return { id, conversationId: 'conv-1', role, content: `msg-${id}`, createdAt: '' };
}

function baseParams(): Parameters<typeof computeRenderState>[0] {
  return {
    isCreateMode: false,
    pendingMessage: null,
    localMessagesLength: 0,
    conversation: { title: 'Test' },
    isConversationLoading: false,
    isMessagesLoading: false,
    isDecryptionPending: false,
  };
}

describe('pruneMessagesAfterTarget', () => {
  it('keeps target and removes messages after it', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant'), makeMessage('u2')];
    let result: typeof messages = [];
    const setter = (function_: (previous: typeof messages) => typeof messages): void => {
      result = function_(messages);
    };

    pruneMessagesAfterTarget(messages, 'a1', setter as never);
    expect(result.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('keeps user message target and removes AI after it', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant')];
    let result: typeof messages = [];
    const setter = (function_: (previous: typeof messages) => typeof messages): void => {
      result = function_(messages);
    };

    pruneMessagesAfterTarget(messages, 'u1', setter as never);
    expect(result.map((m) => m.id)).toEqual(['u1']);
  });

  it('removes multiple messages after target in longer conversation', () => {
    const messages = [
      makeMessage('u1'),
      makeMessage('a1', 'assistant'),
      makeMessage('u2'),
      makeMessage('a2', 'assistant'),
    ];
    let result: typeof messages = [];
    const setter = (function_: (previous: typeof messages) => typeof messages): void => {
      result = function_(messages);
    };

    pruneMessagesAfterTarget(messages, 'u1', setter as never);
    expect(result.map((m) => m.id)).toEqual(['u1']);
  });

  it('does nothing when target not found', () => {
    const messages = [makeMessage('u1')];
    let called = false;
    const setter = (): void => {
      called = true;
    };

    pruneMessagesAfterTarget(messages, 'missing', setter as never);
    expect(called).toBe(false);
  });
});

describe('shouldRedirect', () => {
  it('returns true when in create mode with no pending message and no local messages', () => {
    expect(shouldRedirect(true, null, 0)).toBe(true);
  });

  it('returns false when not in create mode', () => {
    expect(shouldRedirect(false, null, 0)).toBe(false);
  });

  it('returns false when there is a pending message', () => {
    expect(shouldRedirect(true, 'hello', 0)).toBe(false);
  });

  it('returns false when there are local messages', () => {
    expect(shouldRedirect(true, null, 3)).toBe(false);
  });

  it('returns false when pending message is empty string (truthy check)', () => {
    expect(shouldRedirect(true, '', 0)).toBe(true);
  });
});

describe('computeRenderState', () => {
  it('returns redirecting when create mode with no pending message and no local messages', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: null,
      localMessagesLength: 0,
    });
    expect(result).toEqual({ type: 'redirecting' });
  });

  it('returns ready in create mode with pending message', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns not-found when no conversation and not loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      conversation: undefined,
      isConversationLoading: false,
    });
    expect(result).toEqual({ type: 'not-found' });
  });

  it('returns loading when conversation is loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isConversationLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns loading when messages are loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when loading but local messages exist', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
      localMessagesLength: 3,
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns ready when everything loaded and no decryption pending', () => {
    const result = computeRenderState(baseParams());
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns loading with decrypting title when decryption is pending', () => {
    const result = computeRenderState({
      ...baseParams(),
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when decryption pending but in create mode', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'ready' });
  });
});

describe('mergeMessages', () => {
  it('sets modelName on error message from primaryModelId', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: { id: 'err-1', content: 'Something went wrong' },
      primaryModelId: 'smart-model',
    });
    const errorMsg = result.find((m) => m.id === 'err-1');
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.modelName).toBe('smart-model');
  });

  it('does not add error message when chatError is null', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: null,
      primaryModelId: 'smart-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('u1');
  });
});
