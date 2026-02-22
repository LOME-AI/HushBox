import { DurableObject } from 'cloudflare:workers';

import type { PresenceUpdateEvent } from './events.js';

/** Metadata attached to each WebSocket connection via serializeAttachment */
export interface ConnectionMeta {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

interface PresenceMember {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

/**
 * Per-conversation broadcast hub using Durable Object Hibernation API.
 *
 * Routes:
 *   GET /websocket?userId=xxx           -- authenticated user WebSocket upgrade
 *   GET /websocket?guest=true&name=xxx  -- link guest WebSocket upgrade
 *   POST /broadcast                     -- API Worker sends events to all connections
 */
export class ConversationRoom extends DurableObject {
  /**
   * Handle incoming requests:
   * - /websocket: WebSocket upgrade (stores connection metadata)
   * - /broadcast: Fan out event to all connected WebSockets
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      return this.handleWebSocketUpgrade(url);
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      return this.handleBroadcast(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocketUpgrade(url: URL): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const isGuest = url.searchParams.get('guest') === 'true';
    const userId = url.searchParams.get('userId');
    const displayName = url.searchParams.get('name');
    const meta: ConnectionMeta = {
      ...(userId !== null && { userId }),
      ...(displayName !== null && { displayName }),
      isGuest,
      connectedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const event = await request.json();
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify(event);

    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        try {
          ws.close(1011, 'Send failed');
        } catch {
          /* already closed */
        }
      }
    }

    return Response.json({ sent: sockets.length });
  }

  /**
   * Hibernation API handler: client sent a message.
   * Only typing events are sent client-to-server. Forward to all OTHER connections.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;

    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket === ws) continue;
      try {
        socket.send(message);
      } catch {
        try {
          socket.close(1011, 'Send failed');
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Hibernation API handler: WebSocket closed.
   * Clean up and broadcast presence update.
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    this.broadcastPresence();
  }

  /**
   * Hibernation API handler: WebSocket error.
   */
  webSocketError(ws: WebSocket, _error: unknown): void {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      /* already closed */
    }
    this.broadcastPresence();
  }

  /**
   * Build and broadcast a presence:update event from current connections.
   */
  private broadcastPresence(): void {
    const sockets = this.ctx.getWebSockets();
    const members: PresenceMember[] = [];

    for (const ws of sockets) {
      const meta = ws.deserializeAttachment() as ConnectionMeta | null;
      if (meta) {
        members.push({
          ...(meta.userId !== undefined && { userId: meta.userId }),
          ...(meta.displayName !== undefined && { displayName: meta.displayName }),
          isGuest: meta.isGuest,
          connectedAt: meta.connectedAt,
        });
      }
    }

    const event: PresenceUpdateEvent = {
      type: 'presence:update',
      timestamp: Date.now(),
      conversationId: '',
      members,
    };

    const message = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        /* dead socket, ignore */
      }
    }
  }
}
