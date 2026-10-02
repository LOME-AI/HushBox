import {
  UPGRADE_TICKET_PARAM,
  WS_HEARTBEAT_PING_MESSAGE,
  WS_HEARTBEAT_PONG_MESSAGE,
} from '@hushbox/shared';
import {
  DECLARED_CURSORS_PARAM,
  MAX_DECLARED_STREAMS,
  serializeStreamCursors,
} from '@hushbox/realtime/protocol';
import { getApiUrl } from './api.js';
import { computeRetryDelay } from './retry.js';
import { getLinkGuestAuth } from '../auth/link-guest-auth.js';
import { parseServerFrame } from './server-frames.js';
import { mintUpgradeTicket } from './ws-ticket.js';
import { useNetworkStore } from '../../stores/network.js';
import type { RunFrame } from './server-frames.js';
import type { RealtimeEvent, RealtimeEventType } from '@hushbox/realtime/events';

// Idle-keepalive heartbeat. On each tick the client sends the ping; the
// Durable Object's setWebSocketAutoResponse answers with the pong from the
// Workers runtime WITHOUT waking the DO or broadcasting to peers. The pong
// (or any other inbound) clears the pong timeout, so an idle-but-alive socket
// no longer trips the half-open detector and reconnects on a fixed cadence.

type EventListener<T extends RealtimeEventType> = (
  event: Extract<RealtimeEvent, { type: T }>
) => void;

// Internal storage type avoids complex Extract narrowing in Map generics
type AnyEventListener = (event: RealtimeEvent) => void;

type RunFrameListener = (frame: RunFrame) => void;
type LiveRunListener = (runId: string | undefined) => void;

export interface ConversationWebSocketOptions {
  conversationId: string;
  /**
   * Overrides the default `/conversations/:id/websocket` path, including any
   * query string of its own (the cursor declaration is appended to it). The
   * trial socket uses this — its upgrade lives at `/chat/trial/websocket` and
   * is keyed by the trial token, not a conversation id.
   */
  wsPath?: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
}

interface ResolvedOptions {
  conversationId: string;
  wsPath?: string;
  onEvent?: (event: RealtimeEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
}

export class ConversationWebSocket {
  private ws: WebSocket | null = null;
  private options: ResolvedOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** 0-based reconnect attempt, feeding the jittered shared backoff schedule; reset on a successful open. */
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private shouldBeConnected = false;
  /**
   * Advanced by every guest ticket mint and by {@link disconnect}. A mint opens
   * its socket only while its generation is still the latest, so a disconnect
   * during the await opens nothing and a superseded mint opens nothing.
   */
  private connectGeneration = 0;
  /** True while a guest ticket mint is in flight: the attempt already under way that a re-entered connect must not duplicate. */
  private mintingTicket = false;
  private _ready = false;
  private networkUnsubscribe: (() => void) | null = null;
  private listeners = new Map<string, Set<AnyEventListener>>();
  private frameListeners = new Set<RunFrameListener>();
  private liveRunListeners = new Set<LiveRunListener>();
  private stateListeners = new Set<() => void>();
  /**
   * The run this connection is following, with the last cursor seen per stream
   * within it. Null whenever the connection is anchored to no run: the room
   * named none on the last `ready` and none has started since, or the run it
   * was following reached its terminal frame. The run and its cursors travel as
   * one value because a stream id names a stream only within its run — the id
   * is a node id plus a per-run sequence, both reset at run start — so a cursor
   * whose run is unknown can neither be declared to the room nor measured
   * against an arriving frame. A stream answered `stream-gone` is dropped so a
   * later connection no longer asks for it.
   */
  private cursorRun: { readonly runId: string; readonly cursors: Map<string, number> } | null =
    null;

  constructor(options: ConversationWebSocketOptions) {
    this.options = {
      heartbeatIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      ...options,
    };
  }

  get conversationId(): string {
    return this.options.conversationId;
  }

  connect(): void {
    if (this.ws || this.mintingTicket) return;
    this.intentionalClose = false;
    this.shouldBeConnected = true;
    // A reconnect armed by the last close would otherwise fire alongside the
    // socket this call is about to create; this connection is its replacement.
    this.clearReconnectTimer();
    this.subscribeToNetwork();

    if (useNetworkStore.getState().isOffline) return;

    this.createConnection();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldBeConnected = false;
    this.connectGeneration += 1;
    this.mintingTicket = false;
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

  /**
   * Resolves true once the server's `ready` frame lands (immediately if it
   * already has), false when `timeoutMs` elapses first. Used by the run
   * transport to gate the run-start POST on an attached socket — POSTing
   * before the socket is registered would stream the run's opening frames
   * into the void.
   */
  waitForReady(timeoutMs: number): Promise<boolean> {
    if (this._ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.onStateChange(() => {
        if (!this._ready) return;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
      timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);
    });
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

  /** Subscribes to run-output frames (stream / stream-gone / run lifecycle). */
  onRunFrame(listener: RunFrameListener): () => void {
    this.frameListeners.add(listener);
    return (): void => {
      this.frameListeners.delete(listener);
    };
  }

  /**
   * Hears the run each connection's opening `ready` frame names as live, or
   * `undefined` when the room is live in none. A socket that reconnects after
   * a run started learns of it only here: `run-started` is never replayed.
   */
  onLiveRun(listener: LiveRunListener): () => void {
    this.liveRunListeners.add(listener);
    return (): void => {
      this.liveRunListeners.delete(listener);
    };
  }

  /** Fires on any connected/ready flip; lets shared-socket consumers rerender. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return (): void => {
      this.stateListeners.delete(listener);
    };
  }

  send(event: RealtimeEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) listener();
  }

  private createConnection(): void {
    if (this.options.wsPath === undefined && getLinkGuestAuth() !== null) {
      void this.connectWithTicket();
      return;
    }
    this.openSocket(this.buildWsUrl(this.options.wsPath ?? this.conversationPath()));
  }

  /**
   * A link guest's upgrade carries a single-use ticket rather than its
   * credential, which must never ride a URL; each attempt therefore mints its
   * own. A failed mint takes the same backoff as a failed upgrade.
   */
  private async connectWithTicket(): Promise<void> {
    this.connectGeneration += 1;
    const generation = this.connectGeneration;
    this.mintingTicket = true;
    let ticket: string;
    try {
      ticket = await mintUpgradeTicket(this.options.conversationId);
    } catch {
      if (generation !== this.connectGeneration) return;
      this.mintingTicket = false;
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.connectGeneration) return;
    this.mintingTicket = false;
    const query = `${UPGRADE_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
    this.openSocket(this.buildWsUrl(`${this.conversationPath()}?${query}`));
  }

  private openSocket(wsUrl: string): void {
    const socket = new WebSocket(wsUrl);
    this.ws = socket;
    // The latch belongs to the socket the server sent `ready` to. Where a swap
    // bypasses the close handler — {@link disconnect} drops `this.ws`, so that
    // handler's identity check returns before clearing it — it is cleared here.
    this._ready = false;

    socket.addEventListener('open', (): void => {
      if (this.ws !== socket) {
        socket.close(1000, 'Client disconnect');
        return;
      }
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.options.onConnectionChange?.(true);
      this.notifyStateChange();
    });

    socket.addEventListener('message', (messageEvent: MessageEvent): void => {
      if (this.ws !== socket) return;

      // Any inbound message proves the socket is alive (the server has no
      // dedicated pong responder; it relays peer traffic and emits ready /
      // presence signals). Treat all of them as the heartbeat's pong.
      this.notePongReceived();

      const raw = String(messageEvent.data);
      // The heartbeat pong is proof-of-life only (notePongReceived already
      // cleared the timeout above); never route it as a frame.
      if (raw === WS_HEARTBEAT_PONG_MESSAGE) {
        return;
      }

      const frame = parseServerFrame(raw);
      if (frame === null) {
        // Malformed frames from transit corruption cannot be fixed
        // client-side; the server validates via Zod before broadcast.
        return;
      }

      if (frame.type === 'ready') {
        this.anchorToRun(frame.runId);
        for (const listener of this.liveRunListeners) listener(frame.runId);
        this._ready = true;
        this.options.onReadyChange?.(true);
        this.notifyStateChange();
        return;
      }

      if (frame.type === 'event') {
        this.dispatchRealtimeEvent(frame.event);
      } else {
        this.dispatchRunFrame(frame);
      }
    });

    socket.addEventListener('close', (): void => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._ready = false;
      this.stopHeartbeat();
      this.options.onConnectionChange?.(false);
      this.options.onReadyChange?.(false);
      this.notifyStateChange();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', (): void => {
      // onerror is always followed by onclose, so reconnect logic is in onclose
    });
  }

  /**
   * Re-anchors the cursor state to the run the room reports live on this
   * connection. A cursor belongs to the run it was collected in, so cursors
   * held against any other run — and cursors held while the room reports no
   * run at all — are dropped rather than left to be declared for a run that
   * cannot answer them. Adopting the run named here is also the only way a
   * connection that observed no `run-started` can attribute the cursors it
   * goes on to collect. The run already held keeps its cursors: they are that
   * run's, and they are what the room answered this connection's declaration
   * against.
   */
  private anchorToRun(runId: string | undefined): void {
    if (runId === undefined) {
      this.cursorRun = null;
      return;
    }
    if (this.cursorRun?.runId === runId) return;
    this.cursorRun = { runId, cursors: new Map() };
  }

  private dispatchRealtimeEvent(event: RealtimeEvent): void {
    this.options.onEvent?.(event);
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener(event);
      }
    }
  }

  private dispatchRunFrame(frame: RunFrame): void {
    switch (frame.type) {
      case 'stream': {
        const run = this.cursorRun;
        // A frame arriving while this connection is anchored to no run belongs
        // to a run it cannot name, so its cursor has nothing to be recorded
        // against and nothing to be measured against.
        if (run === null) break;
        const last = run.cursors.get(frame.streamId) ?? 0;
        // Cursors increase strictly within one run's stream, so a frame at or
        // below the recorded one carries nothing this client has not already
        // dispatched. That is what makes the replay of a declared gap safe to
        // overlap with the live frames around it.
        if (frame.cursor <= last) return;
        run.cursors.set(frame.streamId, frame.cursor);

        break;
      }
      case 'stream-gone': {
        this.cursorRun?.cursors.delete(frame.streamId);

        break;
      }
      case 'run-started': {
        // The room writes a run's opening frame before any of that run's stream
        // frames, so the cursors an earlier run left — including those a replay
        // wrote after that run's terminal frame — are dropped here before this
        // run's first frame is measured against them.
        this.cursorRun = { runId: frame.runId, cursors: new Map() };

        break;
      }
      case 'run-finished': {
        this.cursorRun = null;

        break;
      }
      // No default
    }
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }

  /**
   * The cursors this connection declares, each naming the run it belongs to so
   * the room can answer `stream-gone` rather than replay a stream of the run it
   * is live in against a cursor from an earlier one. Capped at the bound the
   * room enforces: over-cap is not a soft limit there — a declaration above the
   * cap fails the upgrade, so a client holding more live streams than the cap
   * declares the first `MAX_DECLARED_STREAMS` of them rather than losing the
   * socket. Every connection declares, the empty list included — the room reads
   * the declaration before it accepts the socket, which is what lets it
   * withhold a declared stream's live frames until the replay is written.
   */
  private declaredCursors(): string {
    const run = this.cursorRun;
    if (run === null) {
      return serializeStreamCursors([]);
    }
    const declared = [...run.cursors.entries()]
      .slice(0, MAX_DECLARED_STREAMS)
      .map(([streamId, lastEventId]) => ({ streamId, lastEventId, runId: run.runId }));
    return serializeStreamCursors(declared);
  }

  private buildWsUrl(path: string): string {
    const apiUrl = getApiUrl();
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const url = `${wsBase}${path}`;
    const separator = url.includes('?') ? '&' : '?';
    const declaration = encodeURIComponent(this.declaredCursors());
    return `${url}${separator}${DECLARED_CURSORS_PARAM}=${declaration}`;
  }

  private conversationPath(): string {
    return `/conversations/${this.options.conversationId}/websocket`;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (useNetworkStore.getState().isOffline) return;
    // Full-jitter backoff shared with the HTTP retry policy (retry.ts): the
    // delay is a random fraction of an exponentially growing ceiling, so a
    // shared blip can't resynchronize every client into a reconnect storm.
    const delay = computeRetryDelay(this.reconnectAttempts, null);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
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
   * On each interval tick we send an application-level ping and arm a pong
   * timeout. The DO's auto-response pong (or any other inbound) clears it (see
   * notePongReceived). If the timeout elapses with no inbound traffic, the
   * socket is presumed dead and force-closed, which routes through the existing
   * close -> scheduleReconnect machinery. A socket receiving traffic is never
   * churned because every message resets the timeout. The ping is what keeps
   * an idle-but-alive socket from tripping that timeout every cycle.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(WS_HEARTBEAT_PING_MESSAGE);
      }
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
    this.reconnectAttempts = 0;
    if (!this.ws && !this.mintingTicket) this.createConnection();
  }
}
