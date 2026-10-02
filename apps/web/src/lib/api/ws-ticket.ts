import { client, fetchJson } from '../api-client.js';

/**
 * Mints the single-use ticket a link guest presents on its conversation socket
 * upgrade, authenticated by the link credential header the API client attaches.
 * Each ticket opens one socket, so every connect and reconnect mints its own.
 */
export async function mintUpgradeTicket(conversationId: string): Promise<string> {
  const { ticket } = await fetchJson(
    client.conversations[':conversationId']['websocket-ticket'].$post({
      param: { conversationId },
    })
  );
  return ticket;
}
