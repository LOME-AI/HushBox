import * as React from 'react';
import { getUserTier, type UserTierInfo, type UserBalanceState } from '@lome-chat/shared';
import { useSession } from '@/lib/auth';
import { useBalance } from './billing.js';

/**
 * Hook to get user tier info including canAccessPremium.
 * Single source of truth for frontend tier determination.
 *
 * Uses getUserTier() from @lome-chat/shared to ensure consistency
 * with backend tier determination.
 */
export function useTierInfo(): UserTierInfo {
  const { data: session } = useSession();
  const { data: balanceData } = useBalance();

  const balanceState = React.useMemo((): UserBalanceState | null => {
    const isAuthenticated = Boolean(session?.user);
    if (!isAuthenticated) {
      return null; // Guest
    }
    if (!balanceData) {
      return null; // Treat as guest while loading
    }
    return {
      balanceCents: Math.round(Number.parseFloat(balanceData.balance) * 100),
      freeAllowanceCents: balanceData.freeAllowanceCents,
    };
  }, [session?.user, balanceData]);

  return React.useMemo(() => getUserTier(balanceState), [balanceState]);
}
