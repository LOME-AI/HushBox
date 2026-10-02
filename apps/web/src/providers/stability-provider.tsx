import * as React from 'react';
import { useSession, initAuth } from '@/lib/auth/auth';
import { hasStoredAuth } from '@/lib/auth/client';
import { useLinkGuestActive, isLinkGuestActive } from '@/lib/auth/link-guest-auth';
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
  const isLinkGuest = useLinkGuestActive();

  // Both session-derived reads start here, from an effect, and never from the
  // first render. The share route enters link-guest mode in a layout effect —
  // after this provider has already rendered — and in that mode the API client
  // omits credentials, so `/me` and the balance read would be answered 401 on a
  // perfectly live session. Sampling the mode during render reads it as inactive
  // and issues them anyway; reading it here, once the route's layout effect has
  // run, is what keeps them unissued. The two still fire together, so the
  // balance read never waits on `/me`.
  const [likelyAuthenticated, setLikelyAuthenticated] = React.useState(false);

  React.useEffect(() => {
    if (isLinkGuestActive()) return;
    setLikelyAuthenticated(hasStoredAuth());
    void initAuth();
  }, [isLinkGuest]);

  const { data: session, isPending: isSessionPending } = useSession();

  const { data: balanceData, isError: isBalanceError } = useBalance({
    enabled: likelyAuthenticated,
  });

  const isAuthenticated = Boolean(session?.user);

  // A link guest has no session to settle and no balance to load, so both reads
  // are as done as they will ever be — without this the splash waits forever on
  // requests this provider deliberately never issues.
  const isAuthStable = isLinkGuest || !isSessionPending;

  // Balance is stable when:
  // - User is trial (no balance to load), OR
  // - User is authenticated AND the balance query has settled — either with
  //   data (cached or fresh) or with a terminal error. A terminal error must
  //   still count as settled; otherwise a failed balance fetch pins the native
  //   splash (use-splash-screen) forever.
  const isBalanceStable = isLinkGuest || !isAuthenticated || Boolean(balanceData) || isBalanceError;

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
