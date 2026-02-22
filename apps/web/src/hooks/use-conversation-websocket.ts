import { useState, useEffect } from 'react';
import { ConversationWebSocket } from '../lib/ws-client.js';

export function useConversationWebSocket(
  conversationId: string | null
): ConversationWebSocket | null {
  const [ws, setWs] = useState<ConversationWebSocket | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setWs(null);
      return;
    }

    const socket = new ConversationWebSocket({ conversationId });
    socket.connect();
    setWs(socket);

    return (): void => {
      socket.disconnect();
    };
  }, [conversationId]);

  return ws;
}
