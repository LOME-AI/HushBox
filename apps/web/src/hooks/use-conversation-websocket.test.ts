import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

// Use vi.hoisted so the mock class is available in vi.mock's factory
const MockClass = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>) {
    this['connect'] = vi.fn();
    this['disconnect'] = vi.fn();
    this['connected'] = false;
  })
);

vi.mock('../lib/ws-client.js', () => ({
  ConversationWebSocket: MockClass,
}));

import { useConversationWebSocket } from './use-conversation-websocket.js';

describe('useConversationWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockClass.mockImplementation(function (this: Record<string, unknown>) {
      this['connect'] = mockConnect;
      this['disconnect'] = mockDisconnect;
      this['connected'] = false;
    });
  });

  it('returns null when conversationId is null', () => {
    const { result } = renderHook(() => useConversationWebSocket(null));

    expect(result.current).toBeNull();
    expect(MockClass).not.toHaveBeenCalled();
  });

  it('creates and connects WebSocket when conversationId is provided', () => {
    const { result } = renderHook(() => useConversationWebSocket('conv-123'));

    expect(MockClass).toHaveBeenCalledWith({ conversationId: 'conv-123' });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it('disconnects previous WebSocket when conversationId changes', () => {
    const firstConnect = vi.fn();
    const firstDisconnect = vi.fn();
    const secondConnect = vi.fn();
    const secondDisconnect = vi.fn();

    let callCount = 0;
    MockClass.mockImplementation(function (this: Record<string, unknown>) {
      callCount++;
      if (callCount === 1) {
        this['connect'] = firstConnect;
        this['disconnect'] = firstDisconnect;
        this['connected'] = false;
      } else {
        this['connect'] = secondConnect;
        this['disconnect'] = secondDisconnect;
        this['connected'] = false;
      }
    });

    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useConversationWebSocket(id),
      { initialProps: { id: 'conv-1' } }
    );

    expect(firstConnect).toHaveBeenCalledTimes(1);

    rerender({ id: 'conv-2' });

    expect(firstDisconnect).toHaveBeenCalledTimes(1);
    expect(secondConnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects on unmount', () => {
    const { unmount } = renderHook(() => useConversationWebSocket('conv-123'));

    expect(mockConnect).toHaveBeenCalledTimes(1);

    unmount();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('returns WebSocket instance after connect', () => {
    const instanceConnect = vi.fn();
    const instanceDisconnect = vi.fn();
    MockClass.mockImplementation(function (this: Record<string, unknown>) {
      this['connect'] = instanceConnect;
      this['disconnect'] = instanceDisconnect;
      this['connected'] = false;
    });

    const { result } = renderHook(() => useConversationWebSocket('conv-456'));

    expect(result.current).not.toBeNull();
    expect(result.current).toHaveProperty('connect');
    expect(result.current).toHaveProperty('disconnect');
  });

  it('does not create WebSocket for empty string conversationId', () => {
    const { result } = renderHook(() => useConversationWebSocket(''));

    expect(result.current).toBeNull();
    expect(MockClass).not.toHaveBeenCalled();
  });
});
