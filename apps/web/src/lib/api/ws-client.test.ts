import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetApiUrl = vi.hoisted(() => vi.fn(() => 'http://localhost:8787'));
// Keep the real module (retry.ts, pulled in transitively, needs the real
// `ApiError` for its `instanceof` check); only `getApiUrl` is stubbed.
vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api.js')>()),
  getApiUrl: () => mockGetApiUrl(),
}));

const mockGetLinkGuestAuth = vi.fn<() => string | null>(() => null);
vi.mock('../auth/link-guest-auth.js', () => ({
  getLinkGuestAuth: () => mockGetLinkGuestAuth(),
}));

const mockMintUpgradeTicket = vi.hoisted(() => vi.fn<typeof mintUpgradeTicket>());
vi.mock('./ws-ticket.js', () => ({
  mintUpgradeTicket: mockMintUpgradeTicket,
}));

const mockNetworkStore = vi.hoisted(() => {
  let isOffline = false;
  const listeners = new Set<
    (state: { isOffline: boolean; setIsOffline: (v: boolean) => void }) => void
  >();
  return {
    useNetworkStore: {
      getState: (): { isOffline: boolean; setIsOffline: (v: boolean) => void } => ({
        isOffline,
        setIsOffline: () => {},
      }),
      subscribe: (
        listener: (state: { isOffline: boolean; setIsOffline: (v: boolean) => void }) => void
      ): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    },
    _setOffline: (offline: boolean): void => {
      isOffline = offline;
      for (const listener of listeners) {
        listener({ isOffline: offline, setIsOffline: () => {} });
      }
    },
    _reset: (): void => {
      isOffline = false;
      listeners.clear();
    },
    _listenerCount: (): number => listeners.size,
  };
});
vi.mock('../../stores/network.js', () => ({
  useNetworkStore: mockNetworkStore.useNetworkStore,
}));

import { UPGRADE_TICKET_PARAM } from '@hushbox/shared';
import { MAX_DECLARED_STREAMS, parseStreamCursors } from '@hushbox/realtime/protocol';
import { ConversationWebSocket, type ConversationWebSocketOptions } from './ws-client.js';
import type { mintUpgradeTicket } from './ws-ticket.js';

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
    mockNetworkStore._reset();
    const TrackedMock = createMockWebSocketConstructor();
    Object.defineProperty(TrackedMock, 'CONNECTING', { value: 0 });
    Object.defineProperty(TrackedMock, 'OPEN', { value: 1 });
    Object.defineProperty(TrackedMock, 'CLOSING', { value: 2 });
    Object.defineProperty(TrackedMock, 'CLOSED', { value: 3 });
    vi.stubGlobal('WebSocket', TrackedMock);
    mockGetApiUrl.mockReset().mockReturnValue('http://localhost:8787');
    mockGetLinkGuestAuth.mockReset().mockReturnValue(null);
    mockMintUpgradeTicket.mockReset();
    // Pin reconnect jitter to a fixed fraction so backoff timings stay
    // deterministic. The shared ceilings are 500/1000/2000ms…; 0.2 × ceiling
    // reproduces the 100/200/400ms schedule the timing assertions below use.
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  interface DeclaredCursor {
    streamId: string;
    lastEventId: number;
    runId?: string;
  }

  /** The cursor declaration the client put on its upgrade URL, as the room reads it. */
  function declaredCursors(ws: MockWebSocket): DeclaredCursor[] | null {
    const raw = new URL(ws.url).searchParams.get('cursors');
    return raw === null ? null : (JSON.parse(raw) as DeclaredCursor[]);
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
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/conversations/abc-def/websocket?cursors=%5B%5D'
      );
    });

    it('converts http to ws in URL', () => {
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/conversations/conv-123/websocket?cursors=%5B%5D'
      );
    });

    it('converts https to wss in URL', () => {
      mockGetApiUrl.mockReturnValue('https://api.hushbox.ai');
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'wss://api.hushbox.ai/conversations/conv-123/websocket?cursors=%5B%5D'
      );
    });

    it('does not append a ticket when not a link guest', () => {
      mockGetLinkGuestAuth.mockReturnValue(null);
      const client = createClient();
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/conversations/conv-123/websocket?cursors=%5B%5D'
      );
    });

    it('no-ops if already connected', () => {
      const client = createClient();
      client.connect();
      client.connect(); // second call
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('link guest upgrade ticket', () => {
    /** Lets a ticket mint's promise settle, under the fake timers every test here runs on. */
    async function settleMint(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
    }

    function ticketOf(ws: MockWebSocket): string | null {
      return new URL(ws.url).searchParams.get(UPGRADE_TICKET_PARAM);
    }

    beforeEach(() => {
      mockGetLinkGuestAuth.mockReturnValue('link-auth-token');
    });

    it('mints a ticket for the conversation and connects with it', async () => {
      mockMintUpgradeTicket.mockResolvedValueOnce('ticket-1');
      const client = createClient();

      client.connect();
      expect(createdWebSockets).toHaveLength(0);
      await settleMint();

      expect(mockMintUpgradeTicket).toHaveBeenCalledWith('conv-123');
      expect(createdWebSockets).toHaveLength(1);
      expect(getLastWebSocket().url).toBe(
        `ws://localhost:8787/conversations/conv-123/websocket?${UPGRADE_TICKET_PARAM}=ticket-1&cursors=%5B%5D`
      );
    });

    it('never puts the link credential on the upgrade URL', async () => {
      mockMintUpgradeTicket.mockResolvedValueOnce('ticket-1');
      const client = createClient();

      client.connect();
      await settleMint();

      expect(getLastWebSocket().url).not.toContain('link-auth-token');
    });

    it('mints a fresh ticket for each reconnect', async () => {
      mockMintUpgradeTicket.mockResolvedValueOnce('ticket-1').mockResolvedValueOnce('ticket-2');
      const client = createClient();
      client.connect();
      await settleMint();
      simulateOpen(getLastWebSocket());

      simulateUnexpectedClose(getLastWebSocket());
      await vi.advanceTimersByTimeAsync(100);

      expect(mockMintUpgradeTicket).toHaveBeenCalledTimes(2);
      expect(createdWebSockets.map((ws) => ticketOf(ws))).toEqual(['ticket-1', 'ticket-2']);
    });

    it('opens no socket when disconnected while the mint is in flight', async () => {
      mockMintUpgradeTicket.mockResolvedValueOnce('ticket-1');
      const client = createClient();

      client.connect();
      client.disconnect();
      await settleMint();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(createdWebSockets).toHaveLength(0);
    });

    it('opens one socket when connect is called again while the mint is in flight', async () => {
      mockMintUpgradeTicket.mockResolvedValue('ticket-1');
      const client = createClient();

      client.connect();
      client.connect();
      await settleMint();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockMintUpgradeTicket).toHaveBeenCalledTimes(1);
      expect(createdWebSockets.map((ws) => ticketOf(ws))).toEqual(['ticket-1']);
    });

    it('connects again after a disconnect and reconnect during an in-flight mint', async () => {
      mockMintUpgradeTicket.mockResolvedValueOnce('ticket-1').mockResolvedValueOnce('ticket-2');
      const client = createClient();

      client.connect();
      client.disconnect();
      client.connect();
      await settleMint();

      expect(createdWebSockets.map((ws) => ticketOf(ws))).toEqual(['ticket-2']);
    });

    it('schedules a reconnect when the mint fails', async () => {
      mockMintUpgradeTicket
        .mockRejectedValueOnce(new Error('mint refused'))
        .mockResolvedValueOnce('ticket-2');
      const client = createClient();

      client.connect();
      await settleMint();
      expect(createdWebSockets).toHaveLength(0);

      // First-attempt jittered delay: 0.2 × 500ms shared ceiling = 100ms.
      await vi.advanceTimersByTimeAsync(100);

      expect(mockMintUpgradeTicket).toHaveBeenCalledTimes(2);
      expect(createdWebSockets.map((ws) => ticketOf(ws))).toEqual(['ticket-2']);
    });

    it('does not reconnect after a mint failure that lands after a disconnect', async () => {
      mockMintUpgradeTicket.mockRejectedValueOnce(new Error('mint refused'));
      const client = createClient();

      client.connect();
      client.disconnect();
      await settleMint();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockMintUpgradeTicket).toHaveBeenCalledTimes(1);
      expect(createdWebSockets).toHaveLength(0);
    });

    it('opens one socket when the network returns while the mint is in flight', async () => {
      mockMintUpgradeTicket.mockResolvedValue('ticket-1');
      const client = createClient();
      client.connect();

      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);
      await settleMint();

      expect(mockMintUpgradeTicket).toHaveBeenCalledTimes(1);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not mint for a socket opened on an overridden path', () => {
      const client = createClient({ wsPath: '/chat/trial/websocket?token=t' });

      client.connect();

      expect(mockMintUpgradeTicket).not.toHaveBeenCalled();
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('session upgrade', () => {
    it('never mints a ticket', async () => {
      mockGetLinkGuestAuth.mockReturnValue(null);
      const client = createClient();

      client.connect();
      simulateUnexpectedClose(getLastWebSocket());
      await vi.advanceTimersByTimeAsync(100);

      expect(createdWebSockets).toHaveLength(2);
      expect(mockMintUpgradeTicket).not.toHaveBeenCalled();
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
      const client = createClient();
      client.connect();

      client.disconnect();

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

      ws.readyState = MockWebSocket.OPEN;
      simulateOpen(ws);

      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
    });

    it('ignores close events from stale sockets', () => {
      const onConnectionChange = vi.fn();
      const client = createClient({ onConnectionChange });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      ws1.readyState = MockWebSocket.CLOSED;
      ws1.dispatchEvent('close', {} as CloseEvent);

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

      const client = createClient({ onEvent });
      client.connect();
      const ws1 = getLastWebSocket();
      ws1.readyState = MockWebSocket.CONNECTING;

      client.disconnect();

      ws1.readyState = MockWebSocket.OPEN;
      ws1.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('onopen', () => {
    it('resets backoff to initial value', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();

      simulateOpen(ws1);

      simulateUnexpectedClose(ws1);

      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);
      const ws2 = getLastWebSocket();

      simulateOpen(ws2);

      simulateUnexpectedClose(ws2);

      // Should reconnect at the base 100ms again (not the doubled 200ms) because
      // a successful open reset the attempt counter.
      vi.advanceTimersByTime(99);
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

      const client = createClient({ onEvent });
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

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

      const client = createClient();
      client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

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

      const client = createClient();
      client.on('typing:start', typingListener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(typingListener).not.toHaveBeenCalled();
    });

    it('ignores invalid frames (unparseable payload)', () => {
      const onEvent = vi.fn();
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

      const client = createClient();
      const unsubscribe = client.on('typing:start', listener);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);
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

      const client = createClient();
      client.on('typing:start', listener1);
      client.on('typing:start', listener2);
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', {
        data: JSON.stringify({ type: 'event', event: fakeEvent }),
      } as MessageEvent);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
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
    it('recovers via the close path, not the error event, when the socket errors', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // A browser always follows onerror with onclose; the error alone must
      // not tear anything down or double-schedule a reconnect.
      ws.dispatchEvent('error', {} as Event);
      vi.advanceTimersByTime(5000);
      expect(createdWebSockets).toHaveLength(1);
      expect(client.connected).toBe(true);

      simulateUnexpectedClose(ws);
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('schedules reconnect on unexpected close', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      simulateUnexpectedClose(ws);

      // First-attempt jittered delay: 0.2 × 500ms shared ceiling = 100ms.
      vi.advanceTimersByTime(99);
      expect(createdWebSockets).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('jitters the reconnect delay across the shared backoff ceiling', () => {
      // Full-jitter reuse of retry.ts: the delay is Math.random() × the shared
      // backoff ceiling (500ms for the first attempt), never the fixed ceiling
      // itself. De-correlating reconnects stops a shared blip from
      // resynchronizing every client into a thundering-herd retry.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const client = createClient();
      client.connect();
      simulateUnexpectedClose(getLastWebSocket());

      // A deterministic schedule would fire at the full 500ms ceiling; the
      // jittered delay fires at 250ms (0.5 × 500).
      vi.advanceTimersByTime(249);
      expect(createdWebSockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('applies exponential backoff', () => {
      const client = createClient();
      client.connect();

      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      // backoff 200ms (no onopen fired, so backoff stays doubled)
      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(3);

      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(399);
      expect(createdWebSockets).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(4);
    });

    it('caps backoff at the shared ceiling', () => {
      const client = createClient();
      client.connect();

      // Jittered delays (0.2 × the shared ceiling): 100, 200, 400, 800, 1600.
      for (const delay of [100, 200, 400, 800, 1600]) {
        simulateUnexpectedClose(getLastWebSocket());
        vi.advanceTimersByTime(delay);
      }
      expect(createdWebSockets).toHaveLength(6);

      // Further attempts are capped at 2000ms (0.2 × the 10s shared maximum).
      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(1999);
      expect(createdWebSockets).toHaveLength(6);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(7);
    });

    it('does not reconnect after intentional disconnect', () => {
      const client = createClient();
      client.connect();

      client.disconnect();

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('opens no second socket when connect() lands while a reconnect is pending', () => {
      const client = createClient();
      client.connect();
      simulateUnexpectedClose(getLastWebSocket());

      // The close armed a reconnect. A connect() arriving before it fires takes
      // that reconnect over; letting the timer run too would leave a socket
      // nothing holds delivering frames no handler reads.
      client.connect();
      expect(createdWebSockets).toHaveLength(2);

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(2);
    });
  });

  describe('network-aware reconnection', () => {
    it('does not create WebSocket when offline at connect time', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      expect(createdWebSockets).toHaveLength(0);
    });

    it('creates WebSocket when network restores after offline connect', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      expect(createdWebSockets).toHaveLength(0);

      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('cancels pending reconnect timer when network is lost', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulateUnexpectedClose(ws);

      // Going offline should cancel the timer
      mockNetworkStore._setOffline(true);

      vi.advanceTimersByTime(2000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('reconnects immediately when network restores (skips backoff)', () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);
      simulateUnexpectedClose(ws);

      mockNetworkStore._setOffline(true);

      // Coming back online should reconnect immediately, no waiting.
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('resets backoff to initial on network restore', () => {
      const client = createClient();
      client.connect();
      simulateUnexpectedClose(getLastWebSocket()); // backoff=100
      vi.advanceTimersByTime(100);
      expect(createdWebSockets).toHaveLength(2);

      simulateUnexpectedClose(getLastWebSocket()); // backoff=200
      vi.advanceTimersByTime(200);
      expect(createdWebSockets).toHaveLength(3);

      // Going offline then back online resets backoff to initial.
      simulateUnexpectedClose(getLastWebSocket()); // would be backoff=400
      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(4);

      // Initial backoff is 100, not 800
      simulateUnexpectedClose(getLastWebSocket());
      vi.advanceTimersByTime(99);
      expect(createdWebSockets).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(createdWebSockets).toHaveLength(5);
    });

    it('does not reconnect on network restore after intentional disconnect', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      client.disconnect();

      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);

      expect(createdWebSockets).toHaveLength(1);
    });

    it('unsubscribes from network store on disconnect', () => {
      const client = createClient();
      client.connect();
      expect(mockNetworkStore._listenerCount()).toBe(1);

      client.disconnect();
      expect(mockNetworkStore._listenerCount()).toBe(0);

      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('subscribes to the network store once across repeated offline connects', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();
      client.connect();

      expect(mockNetworkStore._listenerCount()).toBe(1);
      expect(createdWebSockets).toHaveLength(0);

      // A single subscription means restoration opens exactly one socket.
      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('ignores network store updates that do not flip the offline state', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      mockNetworkStore._setOffline(false); // still online: neither lost nor restored

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not open a second socket when the network restores while one is alive', () => {
      const client = createClient();
      client.connect();
      simulateOpen(getLastWebSocket());

      // Going offline does not tear down a live socket; restoration must not
      // race a duplicate connection alongside it.
      mockNetworkStore._setOffline(true);
      mockNetworkStore._setOffline(false);

      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not schedule reconnect while offline', () => {
      mockNetworkStore._setOffline(true);
      const client = createClient();
      client.connect();

      mockNetworkStore._setOffline(false);
      expect(createdWebSockets).toHaveLength(1);

      mockNetworkStore._setOffline(true);

      simulateUnexpectedClose(getLastWebSocket());

      vi.advanceTimersByTime(10_000);
      expect(createdWebSockets).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    function simulateInbound(ws: MockWebSocket): void {
      // Any inbound message counts as proof-of-life. Use the ready signal so
      // the event-dispatch path stays inert (no parseEvent / activity store).
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
    }

    function simulatePong(ws: MockWebSocket): void {
      ws.dispatchEvent('message', { data: '{"type":"pong"}' } as MessageEvent);
    }

    it('sends an application-level ping on each heartbeat tick', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      expect(ws.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000); // first heartbeat tick

      expect(ws.send).toHaveBeenCalledWith('{"type":"ping"}');
    });

    it('resets the pong timeout when a pong arrives, preventing reconnect', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(30_000); // ping sent, pong timeout armed
      vi.advanceTimersByTime(5000); // mid-window
      simulatePong(ws); // runtime auto-response pong clears the timeout
      vi.advanceTimersByTime(5000); // original timeout instant passes

      expect(ws.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(1);
    });

    it('does not surface a pong as a chat or presence event', () => {
      const onEvent = vi.fn();
      const listener = vi.fn();
      const client = createClient({
        onEvent,
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
      });
      client.on('presence:update', listener);
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulatePong(ws);

      expect(onEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('force-closes a half-open socket when no inbound arrives before the pong timeout', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Half-open: no further inbound messages, and no native close fires.
      // Ping interval elapses, arming the pong timeout.
      vi.advanceTimersByTime(30_000);
      expect(ws.close).not.toHaveBeenCalled();

      // Pong never arrives within the timeout -> socket presumed dead.
      vi.advanceTimersByTime(10_000);
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it('reconnects after a half-open socket is force-closed by the heartbeat', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(40_000); // ping interval + pong timeout
      expect(createdWebSockets).toHaveLength(1);

      // Force-close routes through the existing close -> scheduleReconnect path.
      vi.advanceTimersByTime(1000);
      expect(createdWebSockets).toHaveLength(2);
    });

    it('does not churn a healthy socket that keeps receiving inbound messages', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Inbound traffic arrives inside every heartbeat window: cross the
      // ping interval, then deliver a message a few seconds later (well
      // before the pong timeout), repeatedly.
      for (let cycle = 0; cycle < 5; cycle++) {
        vi.advanceTimersByTime(31_000); // ping fires (~30s), pong timeout armed
        simulateInbound(ws); // arrives ~1s into the 10s window -> clears it
      }

      expect(ws.close).not.toHaveBeenCalled();
      expect(createdWebSockets).toHaveLength(1);
    });

    it('clears a pending pong timeout when inbound arrives before it expires', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(30_000); // ping fires, pong timeout armed
      vi.advanceTimersByTime(9999); // just before timeout
      simulateInbound(ws); // pong arrives -> clears timeout
      vi.advanceTimersByTime(1); // original timeout instant passes

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('does not extend the pong deadline when a second silent tick fires first', () => {
      // A pong window longer than the ping interval means a silent socket
      // sees a second tick while the first window is still open; that tick
      // must not re-arm (push out) the pending deadline.
      const client = createClient({ heartbeatIntervalMs: 10_000, pongTimeoutMs: 25_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(10_000); // first silent tick arms the window (expires t=35s)
      vi.advanceTimersByTime(10_000); // second silent tick at t=20s
      expect(ws.send).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(14_999); // t=34.999s: original deadline not yet reached
      expect(ws.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // t=35s: the FIRST tick's deadline, not the second's
      expect(ws.close).toHaveBeenCalledWith(4000, 'Heartbeat timeout');
    });

    it('cancels an armed pong deadline on disconnect instead of reconnecting later', () => {
      const client = createClient({
        heartbeatIntervalMs: 10_000,
        pongTimeoutMs: 5000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      vi.advanceTimersByTime(10_000); // ping sent, pong deadline armed
      client.disconnect();

      vi.advanceTimersByTime(60_000); // deadline instant and backoff windows pass
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
      expect(createdWebSockets).toHaveLength(1);
    });

    it('sends no ping on a tick when the socket is no longer open', () => {
      const client = createClient({ heartbeatIntervalMs: 10_000, pongTimeoutMs: 5000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      // Half-open in the other direction: the transport left OPEN without a
      // close event (e.g. mid-teardown), so the tick must not throw a send.
      ws.readyState = MockWebSocket.CLOSING;
      vi.advanceTimersByTime(10_000);

      expect(ws.send).not.toHaveBeenCalled();
      // The tick still arms the deadline, so the dead socket is force-closed.
      vi.advanceTimersByTime(5000);
      expect(ws.close).toHaveBeenCalledWith(4000, 'Heartbeat timeout');
    });

    it('does not run the heartbeat before the socket opens', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();

      // Never opened -> heartbeat must not arm.
      vi.advanceTimersByTime(60_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('stops the heartbeat after intentional disconnect', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      client.disconnect();
      ws.close.mockClear();

      // No heartbeat timer should survive teardown.
      vi.advanceTimersByTime(120_000);
      expect(ws.close).not.toHaveBeenCalled();
      expect(createdWebSockets).toHaveLength(1);
    });

    it('stops the heartbeat after the socket closes on its own', () => {
      const client = createClient({
        heartbeatIntervalMs: 30_000,
        pongTimeoutMs: 10_000,
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      simulateUnexpectedClose(ws);
      ws.close.mockClear();

      // The closed socket's heartbeat must not fire and re-close it.
      vi.advanceTimersByTime(120_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('does not leave heartbeat timers running after teardown', () => {
      const client = createClient({ heartbeatIntervalMs: 30_000, pongTimeoutMs: 10_000 });
      client.connect();
      simulateOpen(getLastWebSocket());

      client.disconnect();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('run frames', () => {
    function streamFrame(streamId: string, cursor: number, event: unknown): string {
      return JSON.stringify({ type: 'stream', streamId, cursor, event });
    }
    const delta = (content: string): unknown => ({ kind: 'text-delta', index: 0, content });
    function runStarted(runId: string): string {
      return JSON.stringify({ type: 'run-started', runId });
    }
    /** The room's opening frame, naming the run it is live in or naming none. */
    function readyFrame(runId?: string): string {
      return JSON.stringify(runId === undefined ? { type: 'ready' } : { type: 'ready', runId });
    }

    it('dispatches stream frames to onRunFrame listeners', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      expect(frames).toEqual([
        {
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'text-delta', index: 0, content: 'a' },
        },
      ]);
    });

    it('tells live-run listeners the run each ready frame names, and never as a run frame', () => {
      const client = createClient();
      const liveRuns: (string | undefined)[] = [];
      const frames: unknown[] = [];
      client.onLiveRun((runId) => liveRuns.push(runId));
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: readyFrame('r1') });
      ws.dispatchEvent('message', { data: readyFrame() });

      expect(liveRuns).toEqual(['r1', undefined]);
      expect(frames).toEqual([]);
    });

    it('stops telling a live-run listener once it unsubscribes', () => {
      const client = createClient();
      const liveRuns: (string | undefined)[] = [];
      const unsubscribe = client.onLiveRun((runId) => liveRuns.push(runId));
      client.connect();
      const ws = getLastWebSocket();

      unsubscribe();
      ws.dispatchEvent('message', { data: readyFrame('r1') });

      expect(liveRuns).toEqual([]);
    });

    it('dispatches run-started and run-finished frames', () => {
      const client = createClient();
      const frames: { type: string }[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: '{"type":"run-started","runId":"r1"}' } as MessageEvent);
      ws.dispatchEvent('message', {
        data: JSON.stringify({
          type: 'run-finished',
          runId: 'r1',
          outcome: { outcome: 'succeeded' },
        }),
      } as MessageEvent);

      expect(frames.map((f) => f.type)).toEqual(['run-started', 'run-finished']);
    });

    it('drops duplicate or stale cursors for a stream (replay overlap)', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('b')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('b')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 3, delta('c')) } as MessageEvent);

      expect(frames).toHaveLength(4);
    });

    it('tracks cursors per stream independently', () => {
      const client = createClient();
      const frames: unknown[] = [];
      client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      ws.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('a')) } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s2', 1, delta('b')) } as MessageEvent);

      expect(frames).toHaveLength(3);
    });

    it('declares its per-stream cursors and the run they belong to on the reconnect upgrade', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s2', 2, delta('b')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([
        { streamId: 's1', lastEventId: 4, runId: 'r1' },
        { streamId: 's2', lastEventId: 2, runId: 'r1' },
      ]);
    });

    it('declares nothing when it is anchored to no run', () => {
      // Cursors collected while the connection names no run cannot be
      // attributed to one, and the room could not judge them if they were
      // declared: a stream id names a stream only within its run.
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([]);
    });

    it('records its cursors against the run the ready frame names', () => {
      // The mid-run joiner: it is sent no `run-started`, so the opening frame
      // is the only place it learns which run its cursors belong to.
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: readyFrame('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([
        { streamId: 's1', lastEventId: 4, runId: 'r1' },
      ]);
    });

    it('re-anchors to the run the ready frame names when the run turned over', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);
      // The run turned over while this client was down: the room is live in a
      // later one and answers the declaration it just read with the gap
      // signal, then fans that run's own frames out.
      ws2.dispatchEvent('message', { data: readyFrame('r2') } as MessageEvent);
      ws2.dispatchEvent('message', {
        data: '{"type":"stream-gone","streamId":"s1"}',
      } as MessageEvent);
      ws2.dispatchEvent('message', { data: streamFrame('s1', 1, delta('b')) } as MessageEvent);
      ws2.dispatchEvent('message', { data: streamFrame('s1', 2, delta('c')) } as MessageEvent);

      simulateUnexpectedClose(ws2);
      vi.advanceTimersByTime(200);

      // Naming the dead run here would earn the gap signal a second time and
      // cost this client the replay it is owed.
      expect(declaredCursors(getLastWebSocket())).toEqual([
        { streamId: 's1', lastEventId: 2, runId: 'r2' },
      ]);
    });

    it('discards its cursors when the ready frame names no run', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);
      ws2.dispatchEvent('message', { data: readyFrame() } as MessageEvent);

      simulateUnexpectedClose(ws2);
      vi.advanceTimersByTime(200);

      expect(declaredCursors(getLastWebSocket())).toEqual([]);
    });

    it('keeps its cursors when the ready frame names the run it already holds', () => {
      // The declared cursors are what the room's replay is written against, so
      // dropping them on a reconnect into the same run would re-dispatch every
      // replayed frame the client has already seen.
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 2, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);
      ws2.dispatchEvent('message', { data: readyFrame('r1') } as MessageEvent);

      simulateUnexpectedClose(ws2);
      vi.advanceTimersByTime(200);

      expect(declaredCursors(getLastWebSocket())).toEqual([
        { streamId: 's1', lastEventId: 2, runId: 'r1' },
      ]);
    });

    it("dispatches a later run's opening frames after following a run it never saw start", () => {
      const client = createClient();
      const seen: number[] = [];
      client.onRunFrame((frame) => {
        if (frame.type === 'stream') seen.push(frame.cursor);
      });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 5, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 6, delta('b')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);
      // The run turned over while this socket was down, and the next run reuses
      // the stream id from cursor 1. Measuring those frames against what the
      // previous run left would discard the reply's whole head.
      ws2.dispatchEvent('message', { data: streamFrame('s1', 1, delta('c')) } as MessageEvent);
      ws2.dispatchEvent('message', { data: streamFrame('s1', 2, delta('d')) } as MessageEvent);

      expect(seen).toEqual([5, 6, 1, 2]);
    });

    it('declares an empty list when no streams are live', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([]);
    });

    it('sends no message on the reconnected socket', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('bounds its declaration at the shared stream cap', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      for (let index = 0; index <= MAX_DECLARED_STREAMS; index += 1) {
        ws1.dispatchEvent('message', {
          data: streamFrame(`s${String(index)}`, 1, delta('a')),
        } as MessageEvent);
      }

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      // Read back through the room's own parser, which refuses a declaration
      // above the cap and takes the whole upgrade down with it: naming the run
      // on every cursor lengthens the payload without adding an entry, so the
      // bound the client slices to is still the bound the room applies.
      const raw = new URL(getLastWebSocket().url).searchParams.get('cursors');
      const parsed = parseStreamCursors(raw);
      expect(parsed.ok).toBe(true);
      expect(declaredCursors(getLastWebSocket())).toHaveLength(MAX_DECLARED_STREAMS);
    });

    it('declares nothing after the run finishes', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', {
        data: JSON.stringify({
          type: 'run-finished',
          runId: 'r1',
          outcome: { outcome: 'succeeded' },
        }),
      } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([]);
    });

    it('omits a stream from its declaration after stream-gone', () => {
      const client = createClient();
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 4, delta('a')) } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s2', 2, delta('b')) } as MessageEvent);
      ws1.dispatchEvent('message', {
        data: '{"type":"stream-gone","streamId":"s1"}',
      } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);

      expect(declaredCursors(getLastWebSocket())).toEqual([
        { streamId: 's2', lastEventId: 2, runId: 'r1' },
      ]);
    });

    it('replays the gap it declared on reconnect through to its frame listeners', () => {
      // The room's live buffer for this run, as cursors.
      const buffered = [1, 2, 3];
      const client = createClient();
      const seen: number[] = [];
      client.onRunFrame((frame) => {
        if (frame.type === 'stream') seen.push(frame.cursor);
      });
      client.connect();
      const ws1 = getLastWebSocket();
      simulateOpen(ws1);
      ws1.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws1.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      simulateUnexpectedClose(ws1);
      vi.advanceTimersByTime(100);
      const ws2 = getLastWebSocket();
      simulateOpen(ws2);

      // What the room answers THIS socket, derived from what the socket itself
      // declared: every buffered event past the declared cursor, written ahead
      // of the live frame the socket is withheld from. A socket that declares
      // nothing is withheld from nothing and is answered nothing.
      const declared = declaredCursors(ws2);
      const from = declared?.find((cursor) => cursor.streamId === 's1')?.lastEventId;
      for (const cursor of buffered.filter((c) => from !== undefined && c > from)) {
        ws2.dispatchEvent('message', {
          data: streamFrame('s1', cursor, delta('b')),
        } as MessageEvent);
      }
      ws2.dispatchEvent('message', { data: streamFrame('s1', 4, delta('c')) } as MessageEvent);

      expect(seen).toEqual([1, 2, 3, 4]);
    });

    it("accepts the next run's frames after a late replay repopulated the cursor map", () => {
      const client = createClient();
      const seen: number[] = [];
      client.onRunFrame((frame) => {
        if (frame.type === 'stream') seen.push(frame.cursor);
      });
      client.connect();
      const ws = getLastWebSocket();
      simulateOpen(ws);

      ws.dispatchEvent('message', { data: runStarted('r1') } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);
      // A socket still owed its declared replay is delivered the run's terminal
      // frame first — no replay reproduces that frame — so the replay it is
      // owed lands after the run it belongs to has ended.
      ws.dispatchEvent('message', {
        data: JSON.stringify({
          type: 'run-finished',
          runId: 'r1',
          outcome: { outcome: 'succeeded' },
        }),
      } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 2, delta('b')) } as MessageEvent);
      // The next run reuses the stream id at cursor 1: the id is a node id plus
      // a per-run sequence, and both reset when a run starts.
      ws.dispatchEvent('message', { data: runStarted('r2') } as MessageEvent);
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('c')) } as MessageEvent);

      expect(seen).toEqual([1, 2, 1]);
    });

    it('unsubscribes run frame listeners', () => {
      const client = createClient();
      const frames: unknown[] = [];
      const unsubscribe = client.onRunFrame((frame) => frames.push(frame));
      client.connect();
      const ws = getLastWebSocket();

      unsubscribe();
      ws.dispatchEvent('message', { data: streamFrame('s1', 1, delta('a')) } as MessageEvent);

      expect(frames).toHaveLength(0);
    });
  });

  describe('waitForReady', () => {
    it('resolves true immediately when already ready', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);

      await expect(client.waitForReady(1000)).resolves.toBe(true);
    });

    it('resolves true when the ready frame arrives before the timeout', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const pending = client.waitForReady(1000);
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);

      await expect(pending).resolves.toBe(true);
    });

    it('stays pending through non-ready state changes until the ready frame lands', async () => {
      const client = createClient();
      client.connect();
      const ws = getLastWebSocket();

      const pending = client.waitForReady(1000);
      // The open handler notifies state listeners before the server's ready
      // frame arrives; that flip alone must not resolve the wait.
      simulateOpen(ws);
      let settled = false;
      const tracking = (async (): Promise<void> => {
        await pending;
        settled = true;
      })();
      await Promise.resolve();
      expect(settled).toBe(false);

      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
      await expect(pending).resolves.toBe(true);
      await tracking;
    });

    it('resolves false when the timeout elapses first', async () => {
      const client = createClient();
      client.connect();

      const pending = client.waitForReady(1000);
      vi.advanceTimersByTime(1000);

      await expect(pending).resolves.toBe(false);
    });

    it('resolves false once the socket that latched ready has been replaced', async () => {
      const client = createClient();
      client.connect();
      const first = getLastWebSocket();
      simulateOpen(first);
      first.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
      expect(client.ready).toBe(true);

      // A socket already closing when disconnect() drops it delivers its close
      // event afterwards, so the close handler's identity check returns before
      // it can clear the latch — the ready the server sent this socket must not
      // answer for the connection that replaces it.
      first.readyState = MockWebSocket.CLOSING;
      client.disconnect();
      first.readyState = MockWebSocket.CLOSED;
      first.dispatchEvent('close', {} as CloseEvent);

      client.connect();
      expect(createdWebSockets).toHaveLength(2);

      const pending = client.waitForReady(1000);
      vi.advanceTimersByTime(1000);

      await expect(pending).resolves.toBe(false);
    });
  });

  describe('wsPath override and state changes', () => {
    it('appends the cursor declaration to a wsPath that already carries a query', () => {
      const client = createClient({ wsPath: '/chat/trial/websocket?trialToken=tok-1' });
      client.connect();
      expect(getLastWebSocket().url).toBe(
        'ws://localhost:8787/chat/trial/websocket?trialToken=tok-1&cursors=%5B%5D'
      );
    });

    it('exposes the conversation id', () => {
      const client = createClient({ conversationId: 'conv-9' });
      expect(client.conversationId).toBe('conv-9');
    });

    it('notifies state-change listeners on open, ready, and close', () => {
      const client = createClient();
      const changes: boolean[] = [];
      client.onStateChange(() => changes.push(client.ready));
      client.connect();
      const ws = getLastWebSocket();

      simulateOpen(ws);
      ws.dispatchEvent('message', { data: '{"type":"ready"}' } as MessageEvent);
      simulateUnexpectedClose(ws);

      expect(changes).toEqual([false, true, false]);
    });
  });
});
