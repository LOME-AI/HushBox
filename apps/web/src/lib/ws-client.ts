import type { RealtimeEvent, RealtimeEventType } from '@hushbox/realtime/events';
import { parseEvent } from '@hushbox/realtime/events';
import { getApiUrl } from './api.js';
import { useNetworkStore } from '../stores/network.js';

type EventListener<T extends RealtimeEventType> = (
  event: Extract<RealtimeEvent, { type: T }>
) => void;

// Internal storage type avoids complex Extract narrowing in Map generics
type AnyEventListener = (event: RealtimeEvent) => void;

export interface ConversationWebSocketOptions {
  conversationId: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface ResolvedOptions {
  conversationId: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

export class ConversationWebSocket {
  private ws: WebSocket | null = null;
  private options: ResolvedOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBackoff: number;
  private intentionalClose = false;
  private shouldBeConnected = false;
  private networkUnsubscribe: (() => void) | null = null;
  private listeners = new Map<string, Set<AnyEventListener>>();

  constructor(options: ConversationWebSocketOptions) {
    this.options = {
      initialBackoffMs: 1000,
      maxBackoffMs: 30_000,
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
      this.options.onConnectionChange?.(true);
    });

    socket.addEventListener('message', (messageEvent: MessageEvent): void => {
      if (this.ws !== socket) return;
      try {
        const event = parseEvent(String(messageEvent.data));
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
      }
    });

    socket.addEventListener('close', (): void => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.options.onConnectionChange?.(false);
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
    return `${wsBase}/api/ws/${this.options.conversationId}`;
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
