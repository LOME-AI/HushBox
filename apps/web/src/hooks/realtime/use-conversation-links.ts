import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/api/idempotent-mutation.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { memberKeys, refetchKeyChainOnSettle } from '@/hooks/realtime/use-conversation-members.js';
import type { StreamChatRotation } from '@hushbox/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

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

type ConversationLinksResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['links']['$get'],
  200
>;

export function useConversationLinks(
  conversationId: string | null
): UseQueryResult<ConversationLinksResponse> {
  // Gate only on conversationId — the sibling sidebar queries (members, budgets)
  // do the same. The session cookie authorizes a logged-in member server-side,
  // and the api-client attaches the link credential header in link-guest mode,
  // so a guest still authorizes. Depending on the async-lagging client `user`
  // store left the query disabled at first render, so the owner's links never
  // rendered.
  return useQuery({
    queryKey: linkKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.conversations[':conversationId'].links.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
  });
}

interface CreateLinkVariables {
  conversationId: string;
  linkPublicKey: string;
  linkAuthHash: string;
  memberWrap: string;
  privilege: string;
  giveFullHistory: boolean;
  displayName?: string;
  rotation?: StreamChatRotation;
  expectedEpoch?: number;
}

type CreateLinkResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['links']['$post'],
  200
>;

export function useCreateLink(): UseMutationResult<CreateLinkResponse, Error, CreateLinkVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateLinkVariables) =>
      fetchJson(
        client.conversations[':conversationId'].links.$post(
          {
            param: { conversationId: input.conversationId },
            json: {
              linkPublicKey: input.linkPublicKey,
              linkAuthHash: input.linkAuthHash,
              memberWrap: input.memberWrap,
              privilege: input.privilege as 'read' | 'write',
              giveFullHistory: input.giveFullHistory,
              ...(input.displayName !== undefined && { displayName: input.displayName }),
              ...(input.rotation !== undefined && { rotation: input.rotation }),
              ...(input.expectedEpoch !== undefined && { expectedEpoch: input.expectedEpoch }),
            },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: async (data, variables) => {
      // The new link's seated member is created with it, but the members list
      // otherwise refreshes only over the socket, which a one-member
      // conversation does not open.
      void queryClient.invalidateQueries({ queryKey: memberKeys.list(variables.conversationId) });
      await invalidateLinkAndBudget(queryClient)(data, variables);
    },
    onSettled: refetchKeyChainOnSettle(queryClient),
  });
}

interface ChangeLinkPrivilegeVariables {
  conversationId: string;
  linkId: string;
  privilege: 'read' | 'write';
}

type ChangeLinkPrivilegeResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['links'][':linkId']['privilege']['$patch'],
  200
>;

export function useChangeLinkPrivilege(): UseMutationResult<
  ChangeLinkPrivilegeResponse,
  Error,
  ChangeLinkPrivilegeVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ChangeLinkPrivilegeVariables) =>
      fetchJson(
        client.conversations[':conversationId'].links[':linkId'].privilege.$patch(
          {
            param: { conversationId: input.conversationId, linkId: input.linkId },
            json: { privilege: input.privilege },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}

interface RevokeLinkVariables {
  conversationId: string;
  linkId: string;
  rotation: StreamChatRotation;
}

type RevokeLinkResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['links'][':linkId']['revoke']['$post'],
  200
>;

export function useRevokeLink(): UseMutationResult<RevokeLinkResponse, Error, RevokeLinkVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RevokeLinkVariables) =>
      fetchJson(
        client.conversations[':conversationId'].links[':linkId'].revoke.$post(
          {
            param: { conversationId: input.conversationId, linkId: input.linkId },
            json: { rotation: input.rotation },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
    onSettled: refetchKeyChainOnSettle(queryClient),
  });
}
