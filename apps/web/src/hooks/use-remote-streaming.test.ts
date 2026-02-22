import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteStreaming } from './use-remote-streaming.js';
import type { ConversationWebSocket } from '../lib/ws-client.js';

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
    listeners.get(type)!.add(handler);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRemoteStreaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map with null ws', () => {
    const { result } = renderHook(() => useRemoteStreaming(null, 'user-1'));

    expect(result.current).toBeInstanceOf(Map);
    expect(result.current.size).toBe(0);
  });

  it('message:new with content from other user creates phantom user entry', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:new', {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'other-user',
        content: 'Hello from other user',
      });
    });

    expect(result.current.size).toBe(1);
    const phantom = result.current.get('msg-1');
    expect(phantom).toEqual({
      content: 'Hello from other user',
      senderType: 'user',
      senderId: 'other-user',
    });
  });

  it('message:new with content from self is skipped', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:new', {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'current-user',
        content: 'My own message',
      });
    });

    expect(result.current.size).toBe(0);
  });

  it('message:new without content is ignored', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:new', {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'other-user',
      });
    });

    expect(result.current.size).toBe(0);
  });

  it('message:stream creates AI entry with token content', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'Hello',
      });
    });

    expect(result.current.size).toBe(1);
    const phantom = result.current.get('ai-msg-1');
    expect(phantom).toEqual({
      content: 'Hello',
      senderType: 'ai',
    });
  });

  it('multiple message:stream tokens for same messageId are concatenated', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'Hello',
      });
    });

    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: ' world',
      });
    });

    expect(result.current.size).toBe(1);
    const phantom = result.current.get('ai-msg-1');
    expect(phantom).toEqual({
      content: 'Hello world',
      senderType: 'ai',
    });
  });

  it('message:stream first creates entry then subsequent tokens accumulate', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    // First token creates the entry
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'A',
      });
    });

    expect(result.current.get('ai-msg-1')).toEqual({
      content: 'A',
      senderType: 'ai',
    });

    // Second token accumulates
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'B',
      });
    });

    expect(result.current.get('ai-msg-1')).toEqual({
      content: 'AB',
      senderType: 'ai',
    });

    // Third token accumulates
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'C',
      });
    });

    expect(result.current.get('ai-msg-1')).toEqual({
      content: 'ABC',
      senderType: 'ai',
    });
  });

  it('message:complete removes ALL entries from the map', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    // Add an AI phantom
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'Some AI content',
      });
    });

    expect(result.current.size).toBe(1);

    // Complete clears everything
    act(() => {
      mockWs.emit('message:complete', {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 1,
        epochNumber: 1,
      });
    });

    expect(result.current.size).toBe(0);
  });

  it('both user phantom and AI phantom cleared on message:complete', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    // Add user phantom
    act(() => {
      mockWs.emit('message:new', {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'user-msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'other-user',
        content: 'User message',
      });
    });

    // Add AI phantom
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'AI response',
      });
    });

    expect(result.current.size).toBe(2);

    // Complete clears both
    act(() => {
      mockWs.emit('message:complete', {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 1,
        epochNumber: 1,
      });
    });

    expect(result.current.size).toBe(0);
  });

  it('multiple concurrent streams are tracked independently', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: 'First',
      });
    });

    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-2',
        token: 'Second',
      });
    });

    expect(result.current.size).toBe(2);
    expect(result.current.get('ai-msg-1')).toEqual({
      content: 'First',
      senderType: 'ai',
    });
    expect(result.current.get('ai-msg-2')).toEqual({
      content: 'Second',
      senderType: 'ai',
    });

    // Tokens for each stream accumulate independently
    act(() => {
      mockWs.emit('message:stream', {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'ai-msg-1',
        token: ' stream',
      });
    });

    expect(result.current.get('ai-msg-1')).toEqual({
      content: 'First stream',
      senderType: 'ai',
    });
    expect(result.current.get('ai-msg-2')).toEqual({
      content: 'Second',
      senderType: 'ai',
    });
  });

  it('cleans up listeners on unmount', () => {
    const mockWs = createMockWs();

    const { unmount } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    // Three event types registered
    expect(mockWs.on).toHaveBeenCalledTimes(3);
    expect(mockWs.on).toHaveBeenCalledWith('message:new', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('message:stream', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('message:complete', expect.any(Function));

    // Verify listeners are registered
    const newListeners = mockWs.listeners.get('message:new');
    const streamListeners = mockWs.listeners.get('message:stream');
    const completeListeners = mockWs.listeners.get('message:complete');
    expect(newListeners?.size).toBe(1);
    expect(streamListeners?.size).toBe(1);
    expect(completeListeners?.size).toBe(1);

    unmount();

    // After unmount, all listeners should be removed
    expect(newListeners?.size).toBe(0);
    expect(streamListeners?.size).toBe(0);
    expect(completeListeners?.size).toBe(0);
  });

  it('message:new phantom includes senderId when present', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useRemoteStreaming(mockWs as unknown as ConversationWebSocket, 'current-user')
    );

    act(() => {
      mockWs.emit('message:new', {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'sender-abc',
        content: 'Hello',
      });
    });

    const phantom = result.current.get('msg-1');
    expect(phantom).toBeDefined();
    expect(phantom!.senderId).toBe('sender-abc');
  });
});
