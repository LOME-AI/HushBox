import { useSearchStore } from '@/stores/search';
import { useSession } from '@/lib/auth';

export interface WebSearchState {
  /** Persisted preference; kept across sign-out so it is restored after sign-in. */
  preferred: boolean;
  /**
   * Whether the current user may use web search. It is an authenticated-only
   * feature: the trial chat route rejects it (FEATURE_REQUIRES_AUTH) and the
   * composer toggle is disabled while signed out.
   */
  canUse: boolean;
  /** Effective state (`preferred && canUse`) — the value every consumer reads. */
  active: boolean;
  toggle: () => void;
}

/**
 * Single source of truth for web-search state.
 *
 * The preference persists in localStorage and survives sign-out and session
 * expiry (`resetForUnauthenticated()` only resets the model store), so a stale
 * `true` must never be read straight from the store: it would reserve the
 * worst-case search cost (≈5.75¢), dwarf the 1¢ trial cap, and silently block
 * every trial message. Every consumer — the budget pre-check, the composer
 * toggle, and the send path — reads `active`/`canUse` from here so the
 * "search requires auth" rule has exactly one definition and cannot drift.
 */
export function useWebSearch(): WebSearchState {
  const { webSearchEnabled, toggleWebSearch } = useSearchStore();
  const { data: session, isPending } = useSession();
  const canUse = !isPending && Boolean(session?.user);

  return {
    preferred: webSearchEnabled,
    canUse,
    active: webSearchEnabled && canUse,
    toggle: toggleWebSearch,
  };
}
