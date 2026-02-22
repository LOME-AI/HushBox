import type { QueryClient } from '@tanstack/react-query';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { StreamChatRotation } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';
import { budgetKeys } from './use-conversation-budgets.js';

function invalidateLinkAndBudget(
  queryClient: QueryClient
): (_data: unknown, variables: { conversationId: string }) => Promise<void> {
  return async (_data, variables) => {
    await queryClient.invalidateQueries({
      queryKey: linkKeys.list(variables.conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(variables.conversationId),
    });
  };
}

export const linkKeys = {
  all: ['links'] as const,
  list: (conversationId: string) => [...linkKeys.all, conversationId] as const,
};

export function useConversationLinks(conversationId: string | null): ReturnType<typeof useQuery> {
  return useQuery({
    queryKey: linkKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.api.links[':conversationId'].$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
  });
}

export function useCreateLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      linkPublicKey,
      memberWrap,
      privilege,
      giveFullHistory,
    }: {
      conversationId: string;
      linkPublicKey: string;
      memberWrap: string;
      privilege: string;
      giveFullHistory: boolean;
    }) =>
      fetchJson(
        client.api.links[':conversationId'].$post({
          param: { conversationId },
          json: { linkPublicKey, memberWrap, privilege, giveFullHistory },
        })
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}

export function useChangeLinkPrivilege() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      linkId,
      privilege,
    }: {
      conversationId: string;
      linkId: string;
      privilege: 'read' | 'write';
    }) =>
      fetchJson(
        client.api.links[':conversationId'][':linkId'].privilege.$patch({
          param: { conversationId, linkId },
          json: { privilege },
        })
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}

export function useRevokeLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      linkId,
      rotation,
    }: {
      conversationId: string;
      linkId: string;
      rotation: StreamChatRotation;
    }) =>
      fetchJson(
        client.api.links[':conversationId'].revoke.$post({
          param: { conversationId },
          json: { linkId, rotation },
        })
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}
