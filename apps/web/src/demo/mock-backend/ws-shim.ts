/**
 * Replaces the global `WebSocket` so the demo's conversations connect without
 * a server. The real `ConversationWebSocket` opens a socket to
 * `/conversations/:id/websocket`; this fake dispatches `open` then a single
 * `{"type":"ready"}` frame — the exact signal the client gates fan-out on —
 * and never closes on its own, so there is no reconnect/backoff churn. Sends
 * are accepted and dropped (the demo has no peers). Non-conversation sockets
 * (e.g. Vite HMR in dev) pass through to the real WebSocket untouched.
 */
import type { ServerFrame } from '@hushbox/realtime/protocol';

const CONVERSATION_WS_PREFIX = '/conversations/';
const CONVERSATION_WS_SUFFIX = '/websocket';
const READY_FRAME = '{"type":"ready"}';

type WsListener = (event: unknown) => void;

/**
 * Open fake sockets keyed by conversation id, so the director can push realtime
 * events (group message-replay, typing indicators) and the fetch shim can push
 * run frames to the matching socket.
 */
const openSockets = new Map<string, DemoConversationSocket>();

/** Parse the conversation id out of a `/conversations/:id/websocket?…` url. */
function conversationIdFromUrl(url: string): string {
  const afterPrefix = url.split(CONVERSATION_WS_PREFIX)[1] ?? '';
  return afterPrefix.split(CONVERSATION_WS_SUFFIX)[0] ?? '';
}

function isConversationSocketUrl(url: string): boolean {
  return url.includes(CONVERSATION_WS_PREFIX) && url.includes(CONVERSATION_WS_SUFFIX);
}

/**
 * Push a realtime event to the demo socket of a conversation, wrapped in the
 * `{type:'event', event}` frame the client parses. Returns whether a socket
 * was open to receive it. Best-effort: a missed frame is recovered by the next
 * event's refetch and the ws-ready catch-up refetch.
 */
export function emitDemoRealtimeEvent(conversationId: string, event: object): boolean {
  const socket = openSockets.get(conversationId);
  if (socket === undefined) return false;
  socket.emitEventFrame(event);
  return true;
}

/**
 * How long a chain keeps retrying while the conversation's socket is missing.
 * Covers the acquisition race only; past it the conversation is gone, not slow.
 */
const SOCKET_WAIT_MAX_MS = 2000;

/** The in-flight frame chain per conversation, so an aborted play can stop it. */
const activeFrameChains = new Map<string, () => void>();

/**
 * Streams a run's frames to the conversation's socket with an inter-frame
 * delay (so the reply "types out") plus a one-time lead pause before the
 * first post-label frame — used to simulate image/video generation time.
 * Returns a disposer that drops whatever is still queued.
 *
 * A frame can find the socket missing — the client acquires it and awaits
 * `ready` before POSTing, but the demo's fetch shim schedules frames as it
 * answers the POST — so the chain retries on the same cadence, and gives up
 * after {@link SOCKET_WAIT_MAX_MS} of unbroken absence. Absent that long, the
 * conversation was torn down: its remaining frames would otherwise sit on an
 * 80ms timer for the life of the page and then replay a stale run into
 * whatever socket next claims the id.
 */
export function emitDemoTurnFrames(
  conversationId: string,
  frames: readonly ServerFrame[],
  options: { delayMs: number; leadDelayMs?: number }
): () => void {
  const { delayMs, leadDelayMs = 0 } = options;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let absentSince: number | null = null;

  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
    // Deregister only itself: a chain that gives up late must not detach a newer
    // one for the same conversation, which would leave that one uncancellable.
    if (activeFrameChains.get(conversationId) === stop) activeFrameChains.delete(conversationId);
  };

  const pushNext = (): void => {
    const socket = openSockets.get(conversationId);
    if (socket === undefined) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= SOCKET_WAIT_MAX_MS) {
        stop();
        return;
      }
      timer = setTimeout(pushNext, Math.max(delayMs, 50));
      return;
    }
    absentSince = null;
    const frame = frames[index];
    if (frame === undefined) {
      stop();
      return;
    }
    socket.emitFrame(frame);
    index += 1;
    if (index >= frames.length) {
      stop();
      return;
    }
    // Lead pause between the stream-start label and the first reply frame.
    const wait = index === 2 && leadDelayMs > 0 ? leadDelayMs : delayMs;
    timer = setTimeout(pushNext, wait);
  };

  activeFrameChains.set(conversationId, stop);
  timer = setTimeout(pushNext, 0);
  return stop;
}

/** Drop a conversation's queued frames — the play that asked for them was aborted. */
export function stopDemoTurnFrames(conversationId: string): void {
  activeFrameChains.get(conversationId)?.();
}

/** A permanently-open fake socket for the demo's conversations. */
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

  /** Dispatch a server frame to the client as a JSON `message` frame. */
  emitFrame(frame: ServerFrame): void {
    this.emitJson(frame);
  }

  /**
   * Wrap a realtime event in the `{type:'event', event}` frame and dispatch it.
   * Separate from {@link emitFrame} because the director declares its events as
   * plain objects, so the frame cannot be assembled as a typed `ServerFrame`.
   */
  emitEventFrame(event: object): void {
    this.emitJson({ type: 'event', event });
  }

  private emitJson(payload: object): void {
    this.emit('message', { type: 'message', data: JSON.stringify(payload) });
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
    // No peers and no room in the demo, so every client frame is dropped.
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
 * A `Proxy` construct-trap routes only `/conversations/:id/websocket` sockets
 * to the fake; everything else (Vite HMR in dev) is constructed from the real
 * WebSocket. The proxy forwards property access to the target, so
 * `WebSocket.OPEN` and friends keep their real values without re-declaration.
 */
export function installWebSocketShim(): () => void {
  const Original = globalThis.WebSocket;

  globalThis.WebSocket = new Proxy(Original, {
    construct(target, args): object {
      const url = String(args[0]);
      if (isConversationSocketUrl(url)) {
        return new DemoConversationSocket(url);
      }
      return Reflect.construct(target, args) as object;
    },
  });

  return () => {
    globalThis.WebSocket = Original;
  };
}
