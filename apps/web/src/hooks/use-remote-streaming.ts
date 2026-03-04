import * as React from 'react';
import type { ConversationWebSocket } from '../lib/ws-client.js';

export interface PhantomMessage {
  content: string;
  senderType: 'user' | 'ai';
  senderId?: string;
}

export function useRemoteStreaming(
  ws: ConversationWebSocket | null,
  currentUserId: string | null,
  localStreamingIdRef?: React.RefObject<string | null>
): Map<string, PhantomMessage> {
  const [phantoms, setPhantoms] = React.useState<Map<string, PhantomMessage>>(new Map());

  React.useEffect(() => {
    if (!ws) return;

    const unsubscribes = [
      ws.on('message:new', (event) => {
        if (currentUserId != null && event.senderId === currentUserId) return;
        const { content, senderId, messageId } = event;
        if (content === undefined) return;
        setPhantoms((previous) => {
          const next = new Map(previous);
          next.set(messageId, {
            content,
            senderType: 'user',
            ...(senderId !== undefined && { senderId }),
          });
          return next;
        });
      }),
      ws.on('message:stream', (event) => {
        if (localStreamingIdRef?.current === event.messageId) return;
        setPhantoms((previous) => {
          const next = new Map(previous);
          const existing = next.get(event.messageId);
          if (existing) {
            next.set(event.messageId, { ...existing, content: existing.content + event.token });
          } else {
            next.set(event.messageId, { content: event.token, senderType: 'ai' });
          }
          return next;
        });
      }),
    ];

    return (): void => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }, [ws, currentUserId]);

  return phantoms;
}
