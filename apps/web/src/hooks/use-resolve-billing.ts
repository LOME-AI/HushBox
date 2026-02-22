import * as React from 'react';
import {
  resolveBilling,
  getUserTier,
  type UserBalanceState,
  type UserTier,
  type ResolveBillingResult,
} from '@hushbox/shared';
import { useBalance } from './billing.js';

export interface UseResolveBillingInput {
  /** Estimated minimum cost in cents (from calculateBudget().estimatedMinimumCost * 100) */
  estimatedMinimumCostCents: number;
  /** Whether the selected model is premium */
  isPremiumModel: boolean;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Group budget context from useConversationBudgets */
  group?: {
    effectiveCents: number;
    ownerTier: UserTier;
    ownerBalanceCents: number;
  };
}

/**
 * Hook that resolves billing for the current message.
 * Calls `resolveBilling()` from `@hushbox/shared` with user's balance data.
 *
 * Returns a `ResolveBillingResult` — either a `fundingSource` or `{ fundingSource: 'denied', reason }`.
 */
export function useResolveBilling(input: UseResolveBillingInput): ResolveBillingResult {
  const { data: balanceData } = useBalance();

  const balanceState = React.useMemo((): UserBalanceState | null => {
    if (!input.isAuthenticated) {
      return null;
    }
    if (!balanceData) {
      return null;
    }
    return {
      balanceCents: Number.parseFloat(balanceData.balance) * 100,
      freeAllowanceCents: balanceData.freeAllowanceCents,
    };
  }, [input.isAuthenticated, balanceData]);

  const tierInfo = React.useMemo(() => getUserTier(balanceState), [balanceState]);

  return React.useMemo(
    () =>
      resolveBilling({
        tier: tierInfo.tier,
        balanceCents: tierInfo.balanceCents,
        freeAllowanceCents: tierInfo.freeAllowanceCents,
        isPremiumModel: input.isPremiumModel,
        estimatedMinimumCostCents: input.estimatedMinimumCostCents,
        ...(input.group !== undefined && { group: input.group }),
      }),
    [
      tierInfo.tier,
      tierInfo.balanceCents,
      tierInfo.freeAllowanceCents,
      input.isPremiumModel,
      input.estimatedMinimumCostCents,
      input.group,
    ]
  );
}
