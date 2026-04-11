import { useState, useEffect, useReducer } from 'react';
import { ConversationWebSocket } from '../lib/ws-client.js';

export function useConversationWebSocket(
  conversationId: string | null
): ConversationWebSocket | null {
  const [ws, setWs] = useState<ConversationWebSocket | null>(null);
  const [, rerender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    if (!conversationId) {
      setWs(null);
      return;
    }

    const socket = new ConversationWebSocket({
      conversationId,
      onConnectionChange: rerender,
      onReadyChange: rerender,
    });
    socket.connect();
    setWs(socket);

    return (): void => {
      socket.disconnect();
    };
  }, [conversationId, rerender]);

  return ws;
}
