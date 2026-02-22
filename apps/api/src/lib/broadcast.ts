import type { RealtimeEvent } from '@hushbox/realtime/events';
import type { Bindings } from '../types.js';

/**
 * Send a realtime event to all WebSocket connections in a conversation room.
 * The ConversationRoom DO fans out the event to all connected clients.
 *
 * No-ops gracefully if CONVERSATION_ROOM binding is unavailable (e.g., in tests)
 * or if env is undefined (tests that don't set c.env).
 */
export async function broadcastToRoom(
  env: Bindings | undefined,
  conversationId: string,
  event: RealtimeEvent
): Promise<{ sent: number }> {
  if (!env?.CONVERSATION_ROOM) {
    return { sent: 0 };
  }
  const id = env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = env.CONVERSATION_ROOM.get(id);

  const response = await stub.fetch(
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- internal DO routing, host is ignored
    new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(event),
    })
  );
  const result: { sent: number } = await response.json();
  return result;
}
