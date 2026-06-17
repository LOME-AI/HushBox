/**
 * Replaces the global `WebSocket` so the demo's group conversation connects
 * without a server. The real `ConversationWebSocket` opens a socket to
 * `/api/ws/:id`; this fake dispatches `open` then a single `{"type":"ready"}`
 * message — the exact literal the client matches for fan-out readiness — and
 * never closes on its own, so there is no reconnect/backoff churn. Sends are
 * accepted and dropped (the demo has no peers). Non-conversation sockets (e.g.
 * Vite HMR in dev) pass through to the real WebSocket untouched.
 */

const CONVERSATION_WS_PATH = '/api/ws/';
const READY_FRAME = '{"type":"ready"}';

type WsListener = (event: unknown) => void;

/**
 * Open fake sockets keyed by conversation id, so the director can push realtime
 * events (group message-replay, typing indicators) to the matching socket.
 */
const openSockets = new Map<string, DemoConversationSocket>();

/** Parse the conversation id out of a `/api/ws/:id?…` url. */
function conversationIdFromUrl(url: string): string {
  return url.split(CONVERSATION_WS_PATH)[1]?.split('?')[0] ?? '';
}

/**
 * Push a realtime event to the demo socket of a conversation (as the JSON
 * `message` frame the client parses). Returns whether a socket was open to
 * receive it. Best-effort: a missed frame is recovered by the next event's
 * refetch and the ws-ready catch-up refetch.
 */
export function emitDemoRealtimeEvent(conversationId: string, event: object): boolean {
  const socket = openSockets.get(conversationId);
  if (socket === undefined) return false;
  socket.emitEvent(event);
  return true;
}

/** A permanently-open fake socket for the demo's group conversation. */
export class DemoConversationSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = DemoConversationSocket.OPEN;
  readonly url: string;
  private readonly conversationId: string;
  private readonly listeners = new Map<string, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    this.conversationId = conversationIdFromUrl(url);
    openSockets.set(this.conversationId, this);
    // The client attaches its listeners synchronously right after construction,
    // so defer open + ready to a microtask to guarantee they're caught.
    queueMicrotask(() => {
      this.emit('open', { type: 'open' });
      this.emit('message', { type: 'message', data: READY_FRAME });
    });
  }

  /** Dispatch a realtime event to the client as a JSON `message` frame. */
  emitEvent(event: object): void {
    this.emit('message', { type: 'message', data: JSON.stringify(event) });
  }

  addEventListener(type: string, listener: WsListener): void {
    const set = this.listeners.get(type) ?? new Set<WsListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: WsListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {
    // No peers in the demo — presence/typing frames are dropped.
  }

  close(): void {
    // Client-initiated only (navigation/unmount). Never reconnects.
    this.readyState = DemoConversationSocket.CLOSED;
    if (openSockets.get(this.conversationId) === this) {
      openSockets.delete(this.conversationId);
    }
  }

  private emit(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of set) listener(event);
  }
}

/**
 * Patch `globalThis.WebSocket`. Returns an uninstaller restoring the original.
 *
 * A `Proxy` construct-trap routes only `/api/ws/:id` sockets to the fake;
 * everything else (Vite HMR in dev) is constructed from the real WebSocket. The
 * proxy forwards property access to the target, so `WebSocket.OPEN` and friends
 * keep their real values without re-declaration.
 */
export function installWebSocketShim(): () => void {
  const Original = globalThis.WebSocket;

  globalThis.WebSocket = new Proxy(Original, {
    construct(target, args): object {
      const url = String(args[0]);
      if (url.includes(CONVERSATION_WS_PATH)) {
        return new DemoConversationSocket(url);
      }
      return Reflect.construct(target, args) as object;
    },
  });

  return () => {
    globalThis.WebSocket = Original;
  };
}
