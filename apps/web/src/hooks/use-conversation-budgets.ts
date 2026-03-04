import { useQuery, type UseQueryResult, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UserTier } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

export interface ConversationBudgetsResponse {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    privilege: string;
    budget: string;
    spent: string;
  }[];
  effectiveDollars: number;
  ownerTier: UserTier;
  ownerBalanceDollars: number;
  memberBudgetDollars: number;
}

export const budgetKeys = {
  all: ['budgets'] as const,
  conversation: (conversationId: string) => [...budgetKeys.all, conversationId] as const,
};

export function useConversationBudgets(
  conversationId: string | null
): UseQueryResult<ConversationBudgetsResponse> {
  return useQuery<ConversationBudgetsResponse>({
    queryKey: budgetKeys.conversation(conversationId ?? ''),
    queryFn: () =>
      fetchJson<ConversationBudgetsResponse>(
        client.api.budgets[':conversationId'].$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
    staleTime: Infinity,
  });
}

export function useUpdateMemberBudget() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      memberId,
      budgetCents,
    }: {
      conversationId: string;
      memberId: string;
      budgetCents: number;
    }) =>
      fetchJson(
        client.api.budgets[':conversationId'].member[':memberId'].$patch({
          param: { conversationId, memberId },
          json: { budgetCents },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

export function useUpdateConversationBudget() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      budgetCents,
    }: {
      conversationId: string;
      budgetCents: number;
    }) =>
      fetchJson(
        client.api.budgets[':conversationId'].budget.$patch({
          param: { conversationId },
          json: { budgetCents },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}
