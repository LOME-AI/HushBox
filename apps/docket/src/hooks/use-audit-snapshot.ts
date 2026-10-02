import { useEffect, useState } from 'react';
import { auditSnapshotUrl } from '@/api/audit-routes';
// Type-only: the client reads exactly what the api plugin serves, so the shape
// has one definition rather than a hand-kept copy on this side.
import type { Snapshot } from '@/server/audit-service';

type SnapshotState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: Snapshot }
  | { readonly status: 'failed'; readonly message: string };

export function useAuditSnapshot(audit: string | null): SnapshotState {
  const [state, setState] = useState<SnapshotState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    // The audit it moved off must not stay on screen while the next one is
    // read, so the skeleton covers the switch the way it covers a cold load.
    setState({ status: 'loading' });

    void (async (): Promise<void> => {
      try {
        const response = await fetch(auditSnapshotUrl(audit), { signal: controller.signal });
        if (!response.ok) {
          setState({
            status: 'failed',
            message: `the audit could not be read (${String(response.status)})`,
          });
          return;
        }
        setState({ status: 'ready', snapshot: (await response.json()) as Snapshot });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ status: 'failed', message: error instanceof Error ? error.message : 'unknown' });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [audit]);

  return state;
}
