import * as React from 'react';
import { getUserTier, type UserBalanceState, type UserTierInfo } from '@hushbox/shared';
import { useBalance } from './billing.js';

/**
 * Hook that derives the user's balance state and tier info from balance data.
 *
 * Shared by `useBudgetCalculation` and `useResolveBilling` to avoid
 * duplicating the `balanceState` useMemo + `getUserTier()` computation.
 */
export function useUserTierInfo(isAuthenticated: boolean): UserTierInfo {
  const { data: balanceData } = useBalance();

  const balanceState = React.useMemo((): UserBalanceState | null => {
    if (!isAuthenticated) {
      return null;
    }
    if (!balanceData) {
      return null;
    }
    return {
      balanceCents: Number.parseFloat(balanceData.balance) * 100,
      freeAllowanceCents: balanceData.freeAllowanceCents,
    };
  }, [isAuthenticated, balanceData]);

  return React.useMemo(() => getUserTier(balanceState), [balanceState]);
}
