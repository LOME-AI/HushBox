import * as React from 'react';
import { useSession, initAuth } from '@/lib/auth';
import { useBalance } from '@/hooks/billing';

interface StabilityState {
  /** True when session query has completed initial load */
  isAuthStable: boolean;
  /** True when balance has loaded (or user is trial) */
  isBalanceStable: boolean;
  /** Convenience: all core queries stable */
  isAppStable: boolean;
}

const StabilityContext = React.createContext<StabilityState | null>(null);

interface StabilityProviderProps {
  children: React.ReactNode;
}

export function StabilityProvider({
  children,
}: Readonly<StabilityProviderProps>): React.JSX.Element {
  React.useEffect(() => {
    void initAuth();
  }, []);

  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();

  const isAuthenticated = Boolean(session?.user);

  // Auth is stable when session query completes
  const isAuthStable = !isSessionPending;

  // Balance is stable when:
  // - User is trial (no balance to load), OR
  // - User is authenticated AND we have balance data (cached or fresh)
  const isBalanceStable = !isAuthenticated || Boolean(balanceData);

  // App is stable when all core queries settle
  const isAppStable = isAuthStable && isBalanceStable;

  const value = React.useMemo(
    () => ({ isAuthStable, isBalanceStable, isAppStable }),
    [isAuthStable, isBalanceStable, isAppStable]
  );

  return <StabilityContext.Provider value={value}>{children}</StabilityContext.Provider>;
}

export function useStability(): StabilityState {
  const context = React.useContext(StabilityContext);
  if (!context) {
    throw new Error('useStability must be used within StabilityProvider');
  }
  return context;
}
