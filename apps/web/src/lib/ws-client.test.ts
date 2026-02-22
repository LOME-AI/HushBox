import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock getApiUrl before importing the module — vi.hoisted so we can override per-test
const mockGetApiUrl = vi.hoisted(() => vi.fn(() => 'http://localhost:8787'));
vi.mock('./api.js', () => ({
  getApiUrl: () => mockGetApiUrl(),
}));

// Mock parseEvent from realtime package
const mockParseEvent = vi.fn();
vi.mock('@hushbox/realtime/events', () => ({
  parseEvent: (...args: unknown[]) => mockParseEvent(...args),
}));

import { ConversationWebSocket, type ConversationWebSocketOptions } from './ws-client.js';

// --- Mock WebSocket ---
// readyState starts as OPEN. onopen is NOT auto-fired; tests trigger it manually.

class MockWebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readyState: number = MockWebSocket.OPEN;
  url: string;

  private eventListeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    const set = this.eventListeners.get(type);
    if (set) set.add(listener);
  }

  dispatchEvent(type: string, event: unknown): void {
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent('close', {} as CloseEvent);
  });
}

// Track all created MockWebSocket instances
let createdWebSockets: MockWebSocket[] = [];
const OriginalMockWebSocket = MockWebSocket;

function createMockWebSocketConstructor(): typeof MockWebSocket {
  return class TrackedMockWebSocket extends OriginalMockWebSocket {
    constructor(url: string) {
      super(url);
      createdWebSockets.push(this);
    }
  } as typeof MockWebSocket;
}

function simulateOpen(ws: MockWebSocket): void {
  ws.dispatchEvent('open', {} as Event);
}

function simulateUnexpectedClose(ws: MockWebSocket): void {
  ws.readyState = MockWebSocket.CLOSED;
  ws.dispatchEvent('close', {} as CloseEvent);
}

describe('ConversationWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createdWebSockets = [];
    const TrackedMock = createMockWebSocketConstructor();
    Object.defineProperty(TrackedMock, 'CONNECTING', { value: 0 });
    Object.defineProperty(TrackedMock, 'OPEN', { value: 1 });
    Object.defineProperty(TrackedMock, 'CLOSING', { value: 2 });
    Object.defineProperty(TrackedMock, 'CLOSED', { value: 3 });
    vi.stubGlobal('WebSocket', TrackedMock);
    mockParseEvent.mockReset();
    mockGetApiUrl.mockReset().mockReturnValue('http://localhost:8787');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient(
    overrides: Partial<ConversationWebSocketOptions> = {}
  ): ConversationWebSocket {
    return new ConversationWebSocket({
      conversationId: 'conv-123',
      ...overrides,
    });
  }

  function getLastWebSocket(): MockWebSocket {
    const ws = createdWebSockets.at(-1);
    if (!ws) throw new Error('No WebSocket created');
    return ws;
  }

  describe('construction', () => {
    it('creates instance without connecting', () => {
      const client = createClient();
      expect(client).toBeInstanceOf(ConversationWebSocket);
      expect(createdWebSockets).toHaveLength(0);
    });
  });

  describe('connect', () => {
    it('creates WebSocket with correct URL', () => {
      const client = createClient({ conversationId: 'abc-def' });
      client.connect();
      expect(createdWebSockets).toHaveLength(1);
      expect(getLastWebSocket().url).toBe('ws://localhost:8787/api/ws/abc-def');
    });

    it('converts http to ws in URL', () => {
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe('ws://localhost:8787/api/ws/conv-123');
    });

    it('converts https to wss in URL', () => {
      mockGetApiUrl.mockReturnValue('https://api.hushbox.ai');
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe('wss://api.hushbox.ai/api/ws/conv-123');
    });

    it('no-ops if already connected', () => {
      const client = createClient();
      client.connect();
      client.connect(); // second call
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('connected getter', () => {
    it('returns false before connecting', () => {
      const client = createClient();
      expect(client.connected).toBe(false);
    });

    it('returns true when WebSocket is open', () => {
      const client = createClient();
      client.connect();
      expect(client.connected).toBe(true);
    });

    it('returns false after disconnect', () => {
      const client = createClient();
      client.connect();
      client.disconnect();
      expect(client.connected).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('closes WebSocket with code 1000', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      client.disconnect();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('prevents reconnection after disconnect', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();

      client.disconnect();

      // No new WebSocket should be created even after timer
      vi.advanceTimersByTime(200);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('no-ops if not connected', () => {
      const client = createClient();
      expect(() => {
        client.disconnect();
      }).not.toThrow();
    });

    it('does not call close on CONNECTING socket', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('closes stale socket when it opens after disconnect', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      // Simulate the CONNECTING socket completing its handshake
      ws.readyState = MockWebSocket.OPEN;
      simulateOpen(ws);

      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('ignores close events from stale sockets', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange, initialBackoffMs: 100 });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      // Simulate the stale socket closing
      ws1.readyState = MockWebSocket.CLOSED;
      ws1.dispatchEvent('close', {} as CloseEvent);

      // Should not trigger onConnectionChange or reconnect
      expect(onConnectionChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('ignores messages from stale sockets', () => {
      const onEvent = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 1,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient({ onEvent });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      // Simulate stale socket receiving a message
      ws1.readyState = MockWebSocket.OPEN;
      ws1.dispatchEvent('message', { data: JSON.stringify(fakeEvent) } as MessageEvent);

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('onopen', () => {
    it('resets backoff to initial value', () => {
      const client = createClient({ initialBackoffMs: 500, maxBackoffMs: 10_000 });
      client.connect();
      const ws1 = getLastWebSocket();

      // Fire onopen (resets backoff)
      simulateOpen(ws1);

      // Close unexpectedly - backoff is 500ms (initial)
      simulateUnexpectedClose(ws1);

      // Reconnect at 500ms
      vi.advanceTimersByTime(500);
      expect(createdWebSockets).toHaveLength(2);
      const ws2 = getLastWebSocket();

      // Fire onopen on second connection (resets backoff back to 500)
      simulateOpen(ws2);

      // Close second connection
      simulateUnexpectedClose(ws2);

      // Should reconnect at 500ms again (not 1000ms) because backoff was reset
      vi.advanceTimersByTime(499);
      expect(createdWebSockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(3);
    });

    it('notifies connection change with true', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange });
      client.connect();
      const ws = getLastWebSocket();

      simulateOpen(ws);

      expect(onConnectionChange).toHaveBeenCalledWith(true);
    });
  });

  describe('onclose', () => {
    it('notifies connection change with false', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange });
      client.connect();
      const ws = getLastWebSocket();

      simulateUnexpectedClose(ws);

      expect(onConnectionChange).toHaveBeenCalledWith(false);
    });
  });

  describe('onmessage', () => {
    it('dispatches to onEvent callback', () => {
      const onEvent = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient({ onEvent });
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: JSON.stringify(fakeEvent) } as MessageEvent);

      expect(mockParseEvent).toHaveBeenCalledWith(JSON.stringify(fakeEvent));
      expect(onEvent).toHaveBeenCalledWith(fakeEvent);
    });

    it('dispatches to typed listeners registered via on()', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient();
      client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: JSON.stringify(fakeEvent) } as MessageEvent);

      expect(listener).toHaveBeenCalledWith(fakeEvent);
    });

    it('does not dispatch to listeners for other event types', () => {
      const typingListener = vi.fn();
      const fakeEvent = {
        type: 'message:new' as const,
        timestamp: 123,
        messageId: 'm1',
        conversationId: 'c1',
        senderType: 'user' as const,
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient();
      client.on('typing:start', typingListener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: JSON.stringify(fakeEvent) } as MessageEvent);

      expect(typingListener).not.toHaveBeenCalled();
    });

    it('ignores invalid events (parseEvent throws)', () => {
      const onEvent = vi.fn();
      mockParseEvent.mockImplementation(() => {
        throw new Error('Invalid event');
      });

      const client = createClient({ onEvent });
      client.connect();
      const ws = getLastWebSocket();

      expect(() => {
        ws.dispatchEvent('message', { data: 'not-json' } as MessageEvent);
      }).not.toThrow();
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('on() listener management', () => {
    it('returns unsubscribe function that removes listener', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient();
      const unsubscribe = client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      // First message - listener fires
      ws.dispatchEvent('message', { data: 'msg' } as MessageEvent);
      expect(listener).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Second message - listener does NOT fire
      ws.dispatchEvent('message', { data: 'msg' } as MessageEvent);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports multiple listeners for the same event type', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient();
      client.on('typing:start', listener1);
      client.on('typing:start', listener2);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: 'msg' } as MessageEvent);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('clears all registered listeners', () => {
      const listener = vi.fn();
      const fakeEvent = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      mockParseEvent.mockReturnValue(fakeEvent);

      const client = createClient();
      client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      client.removeAllListeners();

      ws.dispatchEvent('message', { data: 'msg' } as MessageEvent);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('sends JSON-serialized event', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      client.send(event);

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it('throws when not connected', () => {
      const client = createClient();
      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };

      expect(() => {
        client.send(event);
      }).toThrow('WebSocket is not connected');
    });

    it('throws when WebSocket is closed', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.readyState = MockWebSocket.CLOSED;

      const event = {
        type: 'typing:start' as const,
        timestamp: 123,
        conversationId: 'c1',
        userId: 'u1',
      };
      expect(() => {
        client.send(event);
      }).toThrow('WebSocket is not connected');
    });
  });

  describe('auto-reconnect', () => {
    it('schedules reconnect on unexpected close', () => {
      const client = createClient({ initialBackoffMs: 1000 });
      client.connect();
      const ws = getLastWebSocket();

      simulateUnexpectedClose(ws);

      // Before backoff expires
      vi.advanceTimersByTime(999);
      expect(createdWebSockets).toHaveLength(1);

      // After backoff expires
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('applies exponential backoff', () => {
      const client = createClient({ initialBackoffMs: 100, maxBackoffMs: 10_000 });
      client.connect();

      // First close - backoff 100ms
      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      // Second close - backoff 200ms (no onopen fired, so backoff stays doubled)
      simulateUnexpectedClose(getLastWebSocket());

      // Should NOT reconnect after 100ms
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      // Reconnect after another 100ms (total 200ms)
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(3);

      // Third close - backoff 400ms
      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(399);
      expect(createdWebSockets).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(4);
    });

    it('caps backoff at maxBackoffMs', () => {
      const client = createClient({ initialBackoffMs: 1000, maxBackoffMs: 4000 });
      client.connect();

      // Close and reconnect multiple times to exceed cap
      // 1000 -> 2000 -> 4000 -> 4000 (capped)
      for (let index = 0; index < 3; index++) {
        simulateUnexpectedClose(getLastWebSocket());
        const delay = Math.min(1000 * Math.pow(2, index), 4000);
        vi.advanceTimersByTime(delay);
      }
      expect(createdWebSockets).toHaveLength(4);

      // Fourth close - should be capped at 4000ms
      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(3999);
      expect(createdWebSockets).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(5);
    });

    it('does not reconnect after intentional disconnect', () => {
      const client = createClient({ initialBackoffMs: 100 });
      client.connect();

      client.disconnect();

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });
  });
});
