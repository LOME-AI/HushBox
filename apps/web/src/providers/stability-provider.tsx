import * as React from 'react';
import { useSession, initAuth } from '@/lib/auth';
import { hasStoredAuth } from '@/lib/auth-client';
import { useBalance } from '@/hooks/billing/billing';

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

  // Fire balance query optimistically if stored auth exists (sync localStorage check).
  // This runs in parallel with initAuth()'s /api/auth/me call instead of waiting for it.
  const likelyAuthenticated = React.useMemo(() => hasStoredAuth(), []);
  const { data: balanceData, isError: isBalanceError } = useBalance({
    enabled: likelyAuthenticated,
  });

  const isAuthenticated = Boolean(session?.user);

  const isAuthStable = !isSessionPending;

  // Balance is stable when:
  // - User is trial (no balance to load), OR
  // - User is authenticated AND the balance query has settled — either with
  //   data (cached or fresh) or with a terminal error. A terminal error must
  //   still count as settled; otherwise a failed balance fetch pins the native
  //   splash (use-splash-screen) forever.
  const isBalanceStable = !isAuthenticated || Boolean(balanceData) || isBalanceError;

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
