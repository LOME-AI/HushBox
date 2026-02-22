import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — break transitive import chain: chat.js → auth.ts → api.ts (env parse)
// ---------------------------------------------------------------------------

// Mock auth to prevent api.ts env parse
vi.mock('../lib/auth', () => ({
  useAuthStore: vi.fn((selector: (s: { privateKey: null }) => unknown) =>
    selector({ privateKey: null })
  ),
  useSession: vi.fn(() => ({ data: null })),
}));

// Mock crypto (transitive dep of chat.js)
vi.mock('@hushbox/crypto', () => ({
  decryptMessage: vi.fn(),
}));

// Mock shared base64 (transitive dep of chat.js)
vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn(),
  };
});

// Mock epoch-key-cache (transitive dep of chat.js)
vi.mock('../lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => {}),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

// Mock api-client (transitive dep of chat.js, billing.js, use-conversation-budgets.js, use-conversation-members.js)
vi.mock('../lib/api-client.js', () => ({
  client: { api: {} },
  fetchJson: vi.fn(),
}));

// eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...original,
    useQueryClient: vi.fn(() => ({
      invalidateQueries: mockInvalidateQueries,
    })),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useRealtimeSync } from './use-realtime-sync.js';
import type { ConversationWebSocket } from '../lib/ws-client.js';
import { chatKeys } from './chat.js';
import { memberKeys } from './use-conversation-members.js';
import { budgetKeys } from './use-conversation-budgets.js';
import { billingKeys } from './billing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockWs {
  on: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<(event: unknown) => void>>;
  emit: (type: string, event: unknown) => void;
}

function createMockWs(): MockWs {
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  const on = vi.fn((type: string, handler: (event: unknown) => void) => {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    const set = listeners.get(type);
    if (set) set.add(handler);

    return (): void => {
      listeners.get(type)?.delete(handler);
    };
  });

  return {
    on,
    listeners,
    emit: (type: string, event: unknown): void => {
      const set = listeners.get(type);
      if (set) {
        for (const handler of set) {
          handler(event);
        }
      }
    },
  };
}

const CONV_ID = 'conv-1';
const USER_ID = 'user-self';
const OTHER_USER = 'user-other';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRealtimeSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Null guards
  // -------------------------------------------------------------------------

  it('does nothing with null ws', () => {
    renderHook(() => {
      useRealtimeSync(null, CONV_ID, USER_ID);
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('does nothing with null conversationId', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, null, USER_ID);
    });

    expect(mockWs.on).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // message:new
  // -------------------------------------------------------------------------

  it('message:new from other user (no content) invalidates messages', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('message:new', {
      type: 'message:new',
      timestamp: Date.now(),
      messageId: 'msg-1',
      conversationId: CONV_ID,
      senderType: 'user',
      senderId: OTHER_USER,
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.messages(CONV_ID),
    });
  });

  it('message:new from other user with content is skipped', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('message:new', {
      type: 'message:new',
      timestamp: Date.now(),
      messageId: 'msg-1',
      conversationId: CONV_ID,
      senderType: 'user',
      senderId: OTHER_USER,
      content: 'encrypted-blob',
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('message:new from self is skipped', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('message:new', {
      type: 'message:new',
      timestamp: Date.now(),
      messageId: 'msg-1',
      conversationId: CONV_ID,
      senderType: 'user',
      senderId: USER_ID,
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // message:complete
  // -------------------------------------------------------------------------

  it('message:complete invalidates messages, budgets, and balance', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('message:complete', {
      type: 'message:complete',
      timestamp: Date.now(),
      messageId: 'msg-1',
      conversationId: CONV_ID,
      sequenceNumber: 1,
      epochNumber: 1,
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.messages(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: billingKeys.balance(),
    });
  });

  // -------------------------------------------------------------------------
  // member:added
  // -------------------------------------------------------------------------

  it('member:added invalidates members and budgets', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('member:added', {
      type: 'member:added',
      timestamp: Date.now(),
      conversationId: CONV_ID,
      memberId: 'member-1',
      userId: OTHER_USER,
      privilege: 'write',
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation(CONV_ID),
    });
  });

  // -------------------------------------------------------------------------
  // member:removed
  // -------------------------------------------------------------------------

  it('member:removed (other user) invalidates members, budgets, and conversations', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('member:removed', {
      type: 'member:removed',
      timestamp: Date.now(),
      conversationId: CONV_ID,
      memberId: 'member-2',
      userId: OTHER_USER,
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('member:removed (current user) navigates to /chat', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('member:removed', {
      type: 'member:removed',
      timestamp: Date.now(),
      conversationId: CONV_ID,
      memberId: 'member-self',
      userId: USER_ID,
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.conversations(),
    });
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  // -------------------------------------------------------------------------
  // member:privilege-changed
  // -------------------------------------------------------------------------

  it('member:privilege-changed invalidates members and budgets', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('member:privilege-changed', {
      type: 'member:privilege-changed',
      timestamp: Date.now(),
      conversationId: CONV_ID,
      memberId: 'member-1',
      privilege: 'admin',
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: memberKeys.list(CONV_ID),
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation(CONV_ID),
    });
  });

  // -------------------------------------------------------------------------
  // rotation:complete
  // -------------------------------------------------------------------------

  it('rotation:complete invalidates keys and messages', () => {
    const mockWs = createMockWs();

    renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    mockWs.emit('rotation:complete', {
      type: 'rotation:complete',
      timestamp: Date.now(),
      conversationId: CONV_ID,
      newEpochNumber: 2,
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['keys', CONV_ID],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: chatKeys.messages(CONV_ID),
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it('removes all listeners on unmount', () => {
    const mockWs = createMockWs();

    const { unmount } = renderHook(() => {
      useRealtimeSync(mockWs as unknown as ConversationWebSocket, CONV_ID, USER_ID);
    });

    // Verify listeners were registered
    expect(mockWs.on).toHaveBeenCalledWith('message:new', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('message:complete', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('member:added', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('member:removed', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('member:privilege-changed', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('rotation:complete', expect.any(Function));

    // Verify all listener sets have entries
    for (const [, set] of mockWs.listeners) {
      expect(set.size).toBe(1);
    }

    unmount();

    // After unmount, all listeners should be removed
    for (const [, set] of mockWs.listeners) {
      expect(set.size).toBe(0);
    }
  });

  it('removes all listeners when ws changes', () => {
    const mockWs1 = createMockWs();
    const mockWs2 = createMockWs();

    const { rerender } = renderHook(
      ({ ws }: { ws: ConversationWebSocket | null }) => {
        useRealtimeSync(ws, CONV_ID, USER_ID);
      },
      { initialProps: { ws: mockWs1 as unknown as ConversationWebSocket } }
    );

    // Verify listeners on first ws
    for (const [, set] of mockWs1.listeners) {
      expect(set.size).toBe(1);
    }

    // Re-render with new ws
    rerender({ ws: mockWs2 as unknown as ConversationWebSocket });

    // Old ws listeners removed
    for (const [, set] of mockWs1.listeners) {
      expect(set.size).toBe(0);
    }

    // New ws listeners registered
    for (const [, set] of mockWs2.listeners) {
      expect(set.size).toBe(1);
    }
  });
});
