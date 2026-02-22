import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ConversationWebSocket } from '../lib/ws-client.js';
import { chatKeys } from './chat.js';
import { memberKeys } from './use-conversation-members.js';
import { budgetKeys } from './use-conversation-budgets.js';
import { billingKeys } from './billing.js';

export function useRealtimeSync(
  ws: ConversationWebSocket | null,
  conversationId: string | null,
  currentUserId: string | null
): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!ws || !conversationId) return;

    const unsubscribes = [
      ws.on('message:new', (event) => {
        if (currentUserId != null && event.senderId === currentUserId) return;
        if (event.content !== undefined) return;
        void queryClient.invalidateQueries({
          queryKey: chatKeys.messages(conversationId),
        });
      }),
      ws.on('message:complete', () => {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.messages(conversationId),
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
          queryKey: chatKeys.messages(conversationId),
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
