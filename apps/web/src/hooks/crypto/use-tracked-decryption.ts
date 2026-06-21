import { useEffect } from 'react';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';

/**
 * Bumps the global decryption-activity counter while `isPending` is true.
 * `use-is-settled` watches this counter so E2E settled-aware assertions
 * correctly wait for synchronous decryption work that lives outside
 * TanStack Query's `isFetching` window.
 *
 * Only needed for hooks that decrypt outside a `useQuery` queryFn —
 * member-side message decryption runs inside `useMemo` and must declare
 * itself this way. Share-recipient decryption happens inside a queryFn
 * and is already covered by `isFetching`; do not call this from there.
 */
export function useTrackedDecryption(isPending: boolean): void {
  const { markPending, markComplete } = useDecryptionActivityStore.getState();
  useEffect(() => {
    if (!isPending) return;
    markPending();
    return () => {
      markComplete();
    };
  }, [isPending, markPending, markComplete]);
}
