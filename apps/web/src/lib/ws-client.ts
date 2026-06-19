import { parseEvent } from '@hushbox/realtime/events';
import { getApiUrl } from './api.js';
import { getLinkGuestAuth } from './link-guest-auth.js';
import { useNetworkStore } from '../stores/network.js';
import { useWebsocketInboundActivityStore } from '../stores/websocket-inbound-activity.js';
import type { RealtimeEvent, RealtimeEventType } from '@hushbox/realtime/events';

// Two rAFs in a browser ensure the React render + commit triggered by the
// inbound-event listener has been painted before the inbound counter
// decrements, so the settled signal can't fire in the gap between the
// listener's state update and React's effect flush. Non-browser fallback
// (Node tests, Workers without rAF) chains two setTimeout(0) calls for
// the same "next two ticks" effect.
//
// `no-restricted-globals` bans `requestAnimationFrame` in favor of the
// `useAnimationFrame` hook from @hushbox/ui, which respects user motion
// preferences. The exemption here is intentional: this is paint-timing
// for settled-signal correctness, not animation; the work runs regardless
// of motion preferences, and the call site isn't inside a React component
// so a hook isn't usable.
function scheduleAfterPaint(callback: () => void): void {
  // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
  if (typeof requestAnimationFrame === 'function') {
    // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
    requestAnimationFrame(() => {
      // eslint-disable-next-line no-restricted-globals -- paint-timing, not animation; see comment above
      requestAnimationFrame(() => {
        callback();
      });
    });
    return;
  }
  setTimeout(() => {
    setTimeout(callback, 0);
  }, 0);
}

type EventListener<T extends RealtimeEventType> = (
  event: Extract<RealtimeEvent, { type: T }>
) => void;

// Internal storage type avoids complex Extract narrowing in Map generics
type AnyEventListener = (event: RealtimeEvent) => void;

export interface ConversationWebSocketOptions {
  conversationId: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
}

interface ResolvedOptions {
  conversationId: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  initialBackoffMs: number;
  maxBackoffMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
}

export class ConversationWebSocket {
  private ws: WebSocket | null = null;
  private options: ResolvedOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoff: number;
  private intentionalClose = false;
  private shouldBeConnected = false;
  private _ready = false;
  private networkUnsubscribe: (() => void) | null = null;
  private listeners = new Map<string, Set<AnyEventListener>>();

  constructor(options: ConversationWebSocketOptions) {
    this.options = {
      initialBackoffMs: 1000,
      maxBackoffMs: 30_000,
      heartbeatIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      ...options,
    };
    this.currentBackoff = this.options.initialBackoffMs;
  }

  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;
    this.shouldBeConnected = true;
    this.subscribeToNetwork();

    if (useNetworkStore.getState().isOffline) return;

    this.createConnection();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldBeConnected = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.unsubscribeFromNetwork();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      // CONNECTING sockets: the open handler detects staleness and closes them
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True when the server has completed WebSocket registration (fan-out ready). */
  get ready(): boolean {
    return this._ready;
  }

  on<T extends RealtimeEventType>(type: T, listener: EventListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    const set = this.listeners.get(type);
    if (set) set.add(listener as AnyEventListener);
    return (): void => {
      this.listeners.get(type)?.delete(listener as AnyEventListener);
    };
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  send(event: RealtimeEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  private createConnection(): void {
    const wsUrl = this.buildWsUrl();
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.addEventListener('open', (): void => {
      if (this.ws !== socket) {
        socket.close(1000, 'Client disconnect');
        return;
      }
      this.currentBackoff = this.options.initialBackoffMs;
      this.startHeartbeat();
      this.options.onConnectionChange?.(true);
    });

    socket.addEventListener('message', (messageEvent: MessageEvent): void => {
      if (this.ws !== socket) return;

      // Any inbound message proves the socket is alive (the server has no
      // dedicated pong responder; it relays peer traffic and emits ready /
      // presence signals). Treat all of them as the heartbeat's pong.
      this.notePongReceived();

      // Handle connection-level signals before parsing as realtime events
      const raw = String(messageEvent.data);
      if (raw === '{"type":"ready"}') {
        this._ready = true;
        this.options.onReadyChange?.(true);
        return;
      }

      const activity = useWebsocketInboundActivityStore.getState();
      activity.startProcessing();
      try {
        const event = parseEvent(raw);
        this.options.onEvent?.(event);
        const typeListeners = this.listeners.get(event.type);
        if (typeListeners) {
          for (const listener of typeListeners) {
            listener(event);
          }
        }
      } catch {
        // Intentional: malformed events from transit corruption cannot be fixed client-side.
        // Server validates via Zod before broadcast; parse failure here indicates data corruption, not a bug.
      } finally {
        scheduleAfterPaint(() => {
          activity.endProcessing();
        });
      }
    });

    socket.addEventListener('close', (): void => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._ready = false;
      this.stopHeartbeat();
      this.options.onConnectionChange?.(false);
      this.options.onReadyChange?.(false);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', (): void => {
      // onerror is always followed by onclose, so reconnect logic is in onclose
    });
  }

  private buildWsUrl(): string {
    const apiUrl = getApiUrl();
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const base = `${wsBase}/api/ws/${this.options.conversationId}`;
    const linkKey = getLinkGuestAuth();
    if (linkKey) {
      return `${base}?linkPublicKey=${encodeURIComponent(linkKey)}`;
    }
    return base;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (useNetworkStore.getState().isOffline) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, this.currentBackoff);
    this.currentBackoff = Math.min(this.currentBackoff * 2, this.options.maxBackoffMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Detects half-open sockets (mobile sleep, network handoff) that stay in
   * the OPEN readyState but silently stop delivering data and never fire a
   * `close` event. Without this, the close-driven reconnect path never runs.
   *
   * On each interval tick we arm a pong timeout. Any inbound message clears
   * it (see notePongReceived). If the timeout elapses with no inbound traffic,
   * the socket is presumed dead and force-closed, which routes through the
   * existing close -> scheduleReconnect machinery. A socket receiving traffic
   * is never churned because every message resets the timeout.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.armPongTimeout();
    }, this.options.heartbeatIntervalMs);
  }

  private armPongTimeout(): void {
    if (this.pongTimer !== null) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // Half-open: no proof-of-life within the window. Force-close so the
      // close handler tears down state and schedules a reconnect.
      this.ws?.close(4000, 'Heartbeat timeout');
    }, this.options.pongTimeoutMs);
  }

  private notePongReceived(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private subscribeToNetwork(): void {
    if (this.networkUnsubscribe) return;
    let wasOffline = useNetworkStore.getState().isOffline;
    this.networkUnsubscribe = useNetworkStore.subscribe((state) => {
      const isNowOffline = state.isOffline;
      if (wasOffline && !isNowOffline) this.onNetworkRestored();
      else if (!wasOffline && isNowOffline) this.onNetworkLost();
      wasOffline = isNowOffline;
    });
  }

  private unsubscribeFromNetwork(): void {
    this.networkUnsubscribe?.();
    this.networkUnsubscribe = null;
  }

  private onNetworkLost(): void {
    this.clearReconnectTimer();
  }

  private onNetworkRestored(): void {
    if (!this.shouldBeConnected || this.intentionalClose) return;
    this.currentBackoff = this.options.initialBackoffMs;
    if (!this.ws) this.createConnection();
  }
}
