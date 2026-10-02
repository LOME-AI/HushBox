import { useCallback, useState } from 'react';
import { useAuditAddress } from '@/api/audit-address';
import { writeFinding } from '@/api/finding-writes';
import type { ApiDeps } from '@/api/finding-writes';
import type { FindingJson, ProgressStatus } from '@hushbox/docket';

/**
 * `status` is the implementation agent's claim and `verified` is the reader's
 * judgement of it, so the route refuses a body carrying both. Two calls.
 */
interface ProgressPatch {
  readonly status?: ProgressStatus;
  readonly note?: string;
  readonly verified?: boolean;
}

interface ProgressActionsOptions {
  readonly put: (finding: FindingJson) => void;
  readonly api?: ApiDeps;
}

export interface ProgressActions {
  readonly setStatus: (finding: FindingJson, status: ProgressStatus) => void;
  readonly addNote: (finding: FindingJson, text: string) => void;
  readonly setVerified: (finding: FindingJson, verified: boolean) => void;
  readonly errorFor: (id: string) => string | null;
}

interface WriteFailure {
  readonly id: string;
  readonly message: string;
}

/**
 * Tracking writes are not optimistic: the file is the record, the server hands
 * back what it wrote, and the board shows that. A refused write leaves the card
 * exactly as it was and says why.
 */
export function useProgressActions({ put, api }: ProgressActionsOptions): ProgressActions {
  const audit = useAuditAddress();
  const [failure, setFailure] = useState<WriteFailure | null>(null);

  const send = useCallback(
    (finding: FindingJson, patch: ProgressPatch): void => {
      setFailure(null);
      void (async (): Promise<void> => {
        const outcome = await writeFinding(
          { audit: audit, finding: finding, action: 'progress', body: patch },
          api
        );
        if (outcome.ok) {
          put(outcome.value.finding);
          return;
        }
        setFailure({ id: finding.id, message: outcome.message });
      })();
    },
    [api, audit, put]
  );

  return {
    setStatus: useCallback(
      (finding, status) => {
        send(finding, { status });
      },
      [send]
    ),
    addNote: useCallback(
      (finding, note) => {
        send(finding, { note });
      },
      [send]
    ),
    setVerified: useCallback(
      (finding, verified) => {
        send(finding, { verified });
      },
      [send]
    ),
    errorFor: useCallback(
      (id: string): string | null => (failure?.id === id ? failure.message : null),
      [failure]
    ),
  };
}
