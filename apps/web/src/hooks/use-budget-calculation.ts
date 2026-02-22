import * as React from 'react';
import {
  calculateBudget,
  getUserTier,
  type UserBalanceState,
  type BudgetCalculationResult,
} from '@hushbox/shared';

import { useBalance } from './billing.js';
import { useStability } from '@/providers/stability-provider';

// eslint-disable-next-line unicorn/prefer-export-from -- avoids type resolution issues
export type { BudgetCalculationResult };

const DEBOUNCE_MS = 150;

export interface UseBudgetCalculationInput {
  /** Character count for: system prompt + history + current message */
  promptCharacterCount: number;
  /** Model's input price per token (with fees applied) */
  modelInputPricePerToken: number;
  /** Model's output price per token (with fees applied) */
  modelOutputPricePerToken: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
}

/**
 * Hook to calculate budget math in real-time with debouncing.
 * Uses balance data to determine tier and calculate token/cost estimates.
 *
 * Pure math only — no billing decisions or notifications.
 * Billing decisions are handled by `useResolveBilling()`.
 * Notifications are handled by `generateNotifications()` in `usePromptBudget()`.
 *
 * Computes initial result synchronously to avoid flash of empty state on mount.
 * Subsequent updates are debounced to avoid excessive recalculation during typing.
 */
export function useBudgetCalculation(
  input: UseBudgetCalculationInput
): BudgetCalculationResult & { isBalanceLoading: boolean } {
  const { data: balanceData } = useBalance();
  const { isBalanceStable } = useStability();

  // Balance is loading when authenticated and balance isn't stable yet
  const isBalanceLoading = input.isAuthenticated && !isBalanceStable;

  // Memoize balance state to avoid recalculation
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

  // Calculate tier from balance state
  const tierInfo = React.useMemo(() => getUserTier(balanceState), [balanceState]);

  // Compute result synchronously for initial value (prevents flash on mount/route change)
  const computeResult = React.useCallback(
    () =>
      calculateBudget({
        tier: tierInfo.tier,
        balanceCents: tierInfo.balanceCents,
        freeAllowanceCents: tierInfo.freeAllowanceCents,
        promptCharacterCount: input.promptCharacterCount,
        modelInputPricePerToken: input.modelInputPricePerToken,
        modelOutputPricePerToken: input.modelOutputPricePerToken,
        modelContextLength: input.modelContextLength,
      }),
    [
      tierInfo.tier,
      tierInfo.balanceCents,
      tierInfo.freeAllowanceCents,
      input.promptCharacterCount,
      input.modelInputPricePerToken,
      input.modelOutputPricePerToken,
      input.modelContextLength,
    ]
  );

  // Initialize with computed result
  const [debouncedResult, setDebouncedResult] =
    React.useState<BudgetCalculationResult>(computeResult);

  // Debounced calculation effect - runs on mount and when inputs change
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedResult(computeResult());
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [computeResult]);

  return { ...debouncedResult, isBalanceLoading };
}
