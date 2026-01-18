import * as React from 'react';
import {
  calculateBudget,
  getUserTier,
  type BudgetCalculationResult,
  type UserBalanceState,
} from '@lome-chat/shared';
import { useBalance } from './billing.js';
import { useStability } from '@/providers/stability-provider';

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
  /** Whether models data is still loading */
  isModelsLoading?: boolean | undefined;
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
  const { data: balanceData } = useBalance();
  const { isAppStable, isBalanceStable } = useStability();

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

  // Initialize with computed result, filtering errors that depend on loading state
  // This prevents flash of incorrect messages while data is still loading
  const [debouncedResult, setDebouncedResult] = React.useState<BudgetCalculationResult>(() => {
    const result = computeResult();
    const isModelsLoading = Boolean(input.isModelsLoading);

    // Use same filtering logic as debounced effect for consistency
    if (!isAppStable || isModelsLoading) {
      return {
        ...result,
        errors: result.errors.filter(
          (e) =>
            e.id !== 'guest_notice' &&
            e.id !== 'free_tier_notice' &&
            !(isModelsLoading && e.id === 'capacity_exceeded')
        ),
      };
    }
    return result;
  });

  // Debounced calculation effect - runs on mount and when inputs change
  // Filters tier notices when app is not stable (auth/balance still loading)
  // Filters capacity errors when models are still loading
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const result = computeResult();
      const isModelsLoading = Boolean(input.isModelsLoading);

      if (!isAppStable || isModelsLoading) {
        setDebouncedResult({
          ...result,
          errors: result.errors.filter(
            (e) =>
              e.id !== 'guest_notice' &&
              e.id !== 'free_tier_notice' &&
              !(isModelsLoading && e.id === 'capacity_exceeded')
          ),
        });
      } else {
        setDebouncedResult(result);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [computeResult, isAppStable, input.isModelsLoading]);

  return { ...debouncedResult, isBalanceLoading };
}
