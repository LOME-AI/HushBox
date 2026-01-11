import * as React from 'react';
import {
  calculateBudget,
  getUserTier,
  type BudgetCalculationResult,
  type UserBalanceState,
} from '@lome-chat/shared';
import { useBalance } from './billing.js';

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
 * Hook to calculate budget in real-time with debouncing.
 * Uses balance data to determine tier and calculate affordability.
 *
 * Computes initial result synchronously to avoid flash of empty state on mount.
 * Subsequent updates are debounced to avoid excessive recalculation during typing.
 *
 * @param input - Budget calculation inputs (prices, context, character count)
 * @returns Budget calculation result with canAfford, errors, etc.
 */
export function useBudgetCalculation(
  input: UseBudgetCalculationInput
): BudgetCalculationResult & { isBalanceLoading: boolean } {
  const { data: balanceData, isPending: isBalancePending } = useBalance();

  // Loading only applies when authenticated and waiting for balance
  const isBalanceLoading = input.isAuthenticated && isBalancePending;

  // Memoize balance state to avoid recalculation
  const balanceState = React.useMemo((): UserBalanceState | null => {
    if (!input.isAuthenticated) {
      return null; // Guest
    }
    if (!balanceData) {
      return null; // Treat as guest while loading
    }
    return {
      balanceCents: Math.round(parseFloat(balanceData.balance) * 100),
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

  // Initialize with computed result, ALWAYS filtering tier-specific notices
  // This prevents flash of incorrect tier notice on initial render
  // The debounced effect will populate correct tier notices after data loads
  const [debouncedResult, setDebouncedResult] = React.useState<BudgetCalculationResult>(() => {
    const result = computeResult();
    return {
      ...result,
      errors: result.errors.filter((e) => e.id !== 'guest_notice' && e.id !== 'free_tier_notice'),
    };
  });

  // Debounced calculation effect - runs on mount and when computeResult changes
  // On mount, this populates tier notices that were filtered from initial state
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
