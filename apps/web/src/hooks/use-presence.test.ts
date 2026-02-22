import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePresence } from './use-presence.js';
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
    const set = listeners.get(type);
    if (set) set.add(handler);

    // Return unsubscribe function matching ConversationWebSocket.on()
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

describe('usePresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map initially', () => {
    const { result } = renderHook(() => usePresence(null));

    expect(result.current).toBeInstanceOf(Map);
    expect(result.current.size).toBe(0);
  });

  it('updates map when presence:update event fires', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() => usePresence(mockWs as unknown as ConversationWebSocket));

    expect(result.current.size).toBe(0);

    const members = [
      { userId: 'user-1', displayName: 'Alice', isGuest: false, connectedAt: 1_700_000_000_000 },
      { userId: 'user-2', displayName: 'Bob', isGuest: true, connectedAt: 1_700_000_001_000 },
    ];

    act(() => {
      mockWs.emit('presence:update', {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members,
      });
    });

    expect(result.current.size).toBe(2);

    const alice = result.current.get('user-1');
    expect(alice).toEqual({
      userId: 'user-1',
      displayName: 'Alice',
      isGuest: false,
      connectedAt: 1_700_000_000_000,
    });

    const bob = result.current.get('user-2');
    expect(bob).toEqual({
      userId: 'user-2',
      displayName: 'Bob',
      isGuest: true,
      connectedAt: 1_700_000_001_000,
    });
  });

  it('cleans up listener on unmount', () => {
    const mockWs = createMockWs();

    const { unmount } = renderHook(() => usePresence(mockWs as unknown as ConversationWebSocket));

    expect(mockWs.on).toHaveBeenCalledTimes(1);
    expect(mockWs.on).toHaveBeenCalledWith('presence:update', expect.any(Function));

    // Verify listener is registered
    const presenceListeners = mockWs.listeners.get('presence:update');
    expect(presenceListeners?.size).toBe(1);

    unmount();

    // After unmount, the listener should be removed
    expect(presenceListeners?.size).toBe(0);
  });

  it('handles null ws gracefully', () => {
    const { result } = renderHook(() => usePresence(null));

    expect(result.current).toBeInstanceOf(Map);
    expect(result.current.size).toBe(0);
  });

  it('replaces previous presence data on new event', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() => usePresence(mockWs as unknown as ConversationWebSocket));

    act(() => {
      mockWs.emit('presence:update', {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [
          {
            userId: 'user-1',
            displayName: 'Alice',
            isGuest: false,
            connectedAt: 1_700_000_000_000,
          },
        ],
      });
    });

    expect(result.current.size).toBe(1);

    // Second event replaces entire map
    act(() => {
      mockWs.emit('presence:update', {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [
          { userId: 'user-2', displayName: 'Bob', isGuest: true, connectedAt: 1_700_000_002_000 },
        ],
      });
    });

    expect(result.current.size).toBe(1);
    expect(result.current.has('user-1')).toBe(false);
    expect(result.current.has('user-2')).toBe(true);
  });
});
