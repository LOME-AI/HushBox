import {
  useQuery,
  type UseQueryResult,
  useMutation,
  type UseMutationResult,
  useQueryClient,
} from '@tanstack/react-query';
import { centsToNanoUsd } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/api/idempotent-mutation.js';
import { REFETCH_FUNDING_ON_FOCUS } from '@/hooks/billing/funding-freshness.js';
import type { InferResponseType } from 'hono/client';

/**
 * The group-budget display, as the rebuilt `GET /conversations/:id/budgets`
 * serves it: every money field is a canonical `NanoUSD` string (negative-capable
 * for `ownerBalanceNanoUsd` — the owner's purchased wallet can be overdrawn).
 * `ownerBalanceNanoUsd` is served to the owner alone and is null for every other
 * viewer.
 * `effectiveRemainingNanoUsd` is the backend's own hold-aware `min(member cap
 * remaining − member holds, conversation cap remaining − conversation holds,
 * owner balance)` — the exact value admission gates on — so the frontend never
 * re-derives it. The owner-balance dimension stays RAW (never hold-aware) by
 * ruling: members must not infer owner activity. A non-owner viewer receives
 * only their own member row; the owner receives every non-owner member's.
 */
export interface ConversationBudgetsResponse {
  conversationCapNanoUsd: string;
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string | null;
  members: {
    memberId: string;
    userId: string | null;
    username: string | null;
    privilege: string;
    capNanoUsd: string;
    spentNanoUsd: string;
    effectiveRemainingNanoUsd: string;
  }[];
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
      fetchJson(
        client.conversations[':conversationId'].budgets.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    // No staleTime pin (global default applies): the served remaining is
    // hold-aware, so it changes with runs the client may have no socket to —
    // an Infinity pin would keep a remounted view on that stale snapshot
    // forever. Live freshness rides the WS invalidations (run-started,
    // run-finished, ws-ready catch-up), window focus for a view no frame
    // reaches, plus the budget-edit mutations below.
    enabled: !!conversationId,
    refetchOnWindowFocus: REFETCH_FUNDING_ON_FOCUS,
  });
}

interface UpdateMemberBudgetVariables {
  conversationId: string;
  memberId: string;
  budgetCents: number;
}

type UpdateMemberBudgetResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['member'][':memberId']['budget']['$put'],
  200
>;

export function useUpdateMemberBudget(): UseMutationResult<
  UpdateMemberBudgetResponse,
  Error,
  UpdateMemberBudgetVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: UpdateMemberBudgetVariables) =>
      fetchJson(
        client.conversations[':conversationId'].member[':memberId'].budget.$put(
          {
            param: { conversationId: variables.conversationId, memberId: variables.memberId },
            json: { capNanoUsd: centsToNanoUsd(variables.budgetCents) },
          },
          idempotentHeaders(variables)
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

interface UpdateConversationBudgetVariables {
  conversationId: string;
  budgetCents: number;
}

type UpdateConversationBudgetResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['budget']['$put'],
  200
>;

export function useUpdateConversationBudget(): UseMutationResult<
  UpdateConversationBudgetResponse,
  Error,
  UpdateConversationBudgetVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: UpdateConversationBudgetVariables) =>
      fetchJson(
        client.conversations[':conversationId'].budget.$put(
          {
            param: { conversationId: variables.conversationId },
            json: { capNanoUsd: centsToNanoUsd(variables.budgetCents) },
          },
          idempotentHeaders(variables)
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}
