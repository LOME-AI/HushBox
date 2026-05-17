import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { chatKeys } from './chat.js';
import { memberKeys } from './use-conversation-members.js';
import { budgetKeys } from './use-conversation-budgets.js';
import { billingKeys } from './billing.js';
import type { ConversationWebSocket } from '../lib/ws-client.js';

export function useRealtimeSync(
  ws: ConversationWebSocket | null,
  conversationId: string | null,
  currentUserId: string | null
): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Catch-up refetch on every WS-ready transition: the DO retains only
  // live sockets so events broadcast during a disconnect are lost. Without
  // this, a missed `message:complete` leaves the client on stale state
  // until manual nav. Initial-mount fires one redundant refetch.
  const wsReady = ws?.ready ?? false;
  React.useEffect(() => {
    if (!wsReady || !conversationId) return;
    void queryClient.invalidateQueries({
      queryKey: chatKeys.conversation(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: memberKeys.list(conversationId),
    });
  }, [wsReady, conversationId, queryClient]);

  React.useEffect(() => {
    if (!ws || !conversationId) return;

    const unsubscribes = [
      ws.on('message:new', (event) => {
        if (currentUserId != null && event.senderId === currentUserId) return;
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
      }),
      ws.on('message:complete', () => {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: billingKeys.balance(),
        });
      }),
      ws.on('member:added', () => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
      }),
      ws.on('member:removed', (event) => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversations(),
        });
        if (currentUserId != null && event.userId === currentUserId) {
          void navigate({ to: '/chat' });
        }
      }),
      ws.on('member:privilege-changed', () => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
      }),
      ws.on('rotation:complete', () => {
        void queryClient.invalidateQueries({
          queryKey: ['keys', conversationId],
        });
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
      }),
    ];

    return (): void => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }, [ws, conversationId, currentUserId, queryClient, navigate]);
}
