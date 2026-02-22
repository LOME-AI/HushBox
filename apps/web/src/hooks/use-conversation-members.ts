import type { QueryClient } from '@tanstack/react-query';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { StreamChatRotation } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';
import { budgetKeys } from './use-conversation-budgets.js';
import { chatKeys } from './chat.js';

function invalidateMemberAndBudget(
  queryClient: QueryClient
): (_data: unknown, variables: { conversationId: string }) => Promise<void> {
  return async (_data, variables) => {
    await queryClient.invalidateQueries({
      queryKey: memberKeys.list(variables.conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(variables.conversationId),
    });
  };
}

export const memberKeys = {
  all: ['members'] as const,
  list: (conversationId: string) => [...memberKeys.all, conversationId] as const,
};

export function useConversationMembers(conversationId: string | null): ReturnType<typeof useQuery> {
  return useQuery({
    queryKey: memberKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.api.members[':conversationId'].$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
  });
}

export function useAddMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      userId,
      privilege,
      giveFullHistory,
      wrap,
      rotation,
    }: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      wrap?: string;
      rotation?: StreamChatRotation;
    }) =>
      fetchJson(
        client.api.members[':conversationId'].add.$post({
          param: { conversationId },
          json: {
            userId,
            privilege: privilege as 'read' | 'write' | 'admin' | 'owner',
            giveFullHistory,
            ...(wrap !== undefined && { wrap }),
            ...(rotation !== undefined && { rotation }),
          },
        })
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      memberId,
      rotation,
    }: {
      conversationId: string;
      memberId: string;
      rotation: StreamChatRotation;
    }) =>
      fetchJson(
        client.api.members[':conversationId'].remove.$post({
          param: { conversationId },
          json: { memberId, rotation },
        })
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useChangePrivilege() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      memberId,
      privilege,
    }: {
      conversationId: string;
      memberId: string;
      privilege: string;
    }) =>
      fetchJson(
        client.api.members[':conversationId'].privilege.$patch({
          param: { conversationId },
          json: { memberId, privilege: privilege as 'read' | 'write' | 'admin' | 'owner' },
        })
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useLeaveConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      rotation,
    }: {
      conversationId: string;
      rotation?: StreamChatRotation;
    }) =>
      fetchJson(
        client.api.members[':conversationId'].leave.$post({
          param: { conversationId },
          json: { ...(rotation !== undefined && { rotation }) },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
      void queryClient.invalidateQueries({
        queryKey: memberKeys.list(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

export function useAcceptMembership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId }: { conversationId: string }) =>
      fetchJson(
        client.api.members[':conversationId'].accept.$patch({
          param: { conversationId },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}
