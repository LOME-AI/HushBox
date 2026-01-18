import { useSession } from '@/lib/auth';
import { useStability } from '@/providers/stability-provider';

interface StableSessionResult {
  /** The session data, or null if not authenticated */
  session: { user: { id: string; email: string }; session: { id: string } } | null;
  /** True only when auth has settled AND user exists */
  isAuthenticated: boolean;
  /** True when session query has completed (auth is stable) */
  isStable: boolean;
  /** True during initial session determination */
  isPending: boolean;
}

/**
 * Enhanced session hook with stability tracking.
 * Returns isAuthenticated: false during the initial loading period,
 * preventing flash of incorrect auth state.
 */
export function useStableSession(): StableSessionResult {
  const { data: session, isPending } = useSession();
  const { isAuthStable } = useStability();

  return {
    session: session ?? null,
    isAuthenticated: isAuthStable && Boolean(session?.user),
    isStable: isAuthStable,
    isPending,
  };
}
