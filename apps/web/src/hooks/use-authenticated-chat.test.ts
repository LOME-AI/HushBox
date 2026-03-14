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
vi.mock('@hushbox/crypto', () => ({}));

import {
  shouldRedirect,
  computeRenderState,
  pruneMessagesAfterTarget,
  type ComputeRenderStateParams,
} from './use-authenticated-chat';

function makeMessage(id: string, role: 'user' | 'assistant' = 'user'): {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
} {
  return { id, conversationId: 'conv-1', role, content: `msg-${id}`, createdAt: '' };
}

describe('pruneMessagesAfterTarget', () => {
  it('keeps target and removes messages after it', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant'), makeMessage('u2')];
    let result: typeof messages = [];
    const setter = (fn: (prev: typeof messages) => typeof messages): void => {
      result = fn(messages);
    };

    pruneMessagesAfterTarget(messages, 'a1', setter as never);
    expect(result.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('keeps user message target and removes AI after it', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant')];
    let result: typeof messages = [];
    const setter = (fn: (prev: typeof messages) => typeof messages): void => {
      result = fn(messages);
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
    const setter = (fn: (prev: typeof messages) => typeof messages): void => {
      result = fn(messages);
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
  const baseParams: ComputeRenderStateParams = {
    isCreateMode: false,
    pendingMessage: null,
    localMessagesLength: 0,
    conversation: undefined,
    isConversationLoading: false,
    isMessagesLoading: false,
  };

  it('returns redirecting when shouldRedirect is true', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: true,
      pendingMessage: null,
      localMessagesLength: 0,
    });
    expect(result).toEqual({ type: 'redirecting' });
  });

  it('returns ready when in create mode with a pending message', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: true,
      pendingMessage: 'hello',
      localMessagesLength: 0,
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns not-found when conversation is missing and not loading', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: false,
      conversation: undefined,
      isConversationLoading: false,
    });
    expect(result).toEqual({ type: 'not-found' });
  });

  it('returns loading with decrypting title when conversation is loading', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: false,
      conversation: { title: 'test' },
      isConversationLoading: true,
      isMessagesLoading: false,
    });
    expect(result).toEqual({ type: 'loading', title: 'Decrypting...' });
  });

  it('returns ready when conversation is loading but local messages exist', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: false,
      conversation: { title: 'test' },
      isConversationLoading: true,
      localMessagesLength: 2,
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns ready when conversation exists and not loading', () => {
    const result = computeRenderState({
      ...baseParams,
      isCreateMode: false,
      conversation: { title: 'test' },
      isConversationLoading: false,
      isMessagesLoading: false,
    });
    expect(result).toEqual({ type: 'ready' });
  });
});
