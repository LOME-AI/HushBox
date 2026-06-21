import * as React from 'react';
import {
  calculateBudget,
  type BudgetCalculationResult,
  type ModelPricingWithContext,
} from '@hushbox/shared';

import { useStability } from '@/providers/stability-provider';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';

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

  const [debouncedResult, setDebouncedResult] =
    React.useState<BudgetCalculationResult>(computeResult);

  // Synchronously flush result when the tier's *values* change (e.g. balance
  // loaded). Prevents flash of stale "Low Balance" notification when
  // StableContent renders before the debounced effect fires.
  //
  // Compared by value, not by `tierInfo` reference: the balance query can hand
  // back a fresh `tierInfo` object with identical values on every render (e.g.
  // access-revoked flows repeatedly invalidate the balance), and a reference
  // compare would setState every render → "Maximum update depth exceeded".
  const tierKey = `${tierInfo.tier}:${String(tierInfo.balanceCents)}:${String(tierInfo.freeAllowanceCents)}`;
  const [previousTierKey, setPreviousTierKey] = React.useState(tierKey);
  if (previousTierKey !== tierKey) {
    setPreviousTierKey(tierKey);
    setDebouncedResult(computeResult());
  }

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
