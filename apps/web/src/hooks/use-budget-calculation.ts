import * as React from 'react';
import {
  calculateBudget,
  type BudgetCalculationResult,
  type ModelPricingWithContext,
} from '@hushbox/shared';

import { useStability } from '@/providers/stability-provider';
import { useUserTierInfo } from './use-user-tier-info.js';

// eslint-disable-next-line unicorn/prefer-export-from -- avoids type resolution issues
export type { BudgetCalculationResult };

const DEBOUNCE_MS = 150;

export interface UseBudgetCalculationInput {
  /** Character count for: system prompt + history + current message */
  promptCharacterCount: number;
  /** Models to include in budget calculation */
  models: ModelPricingWithContext[];
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Per-search cost in USD (from model metadata, with fees applied). 0 if search disabled. */
  webSearchCost?: number;
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
  const { isBalanceStable } = useStability();

  // Balance is loading when authenticated and balance isn't stable yet
  const isBalanceLoading = input.isAuthenticated && !isBalanceStable;

  const tierInfo = useUserTierInfo(input.isAuthenticated);

  // Compute result synchronously for initial value (prevents flash on mount/route change)
  const computeResult = React.useCallback(
    () =>
      calculateBudget({
        tier: tierInfo.tier,
        balanceCents: tierInfo.balanceCents,
        freeAllowanceCents: tierInfo.freeAllowanceCents,
        promptCharacterCount: input.promptCharacterCount,
        models: input.models,
        webSearchCost: input.webSearchCost ?? 0,
      }),
    [
      tierInfo.tier,
      tierInfo.balanceCents,
      tierInfo.freeAllowanceCents,
      input.promptCharacterCount,
      input.models,
      input.webSearchCost,
    ]
  );

  // Initialize with computed result
  const [debouncedResult, setDebouncedResult] =
    React.useState<BudgetCalculationResult>(computeResult);

  // Synchronously flush result when tier changes (e.g., balance loaded).
  // Prevents flash of stale "Low Balance" notification when StableContent
  // renders before the debounced effect fires.
  const [previousTierInfo, setPreviousTierInfo] = React.useState(tierInfo);
  if (previousTierInfo !== tierInfo) {
    setPreviousTierInfo(tierInfo);
    setDebouncedResult(computeResult());
  }

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
