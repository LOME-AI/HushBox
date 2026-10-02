import { useCallback, useState } from 'react';
import { useAuditAddress } from '@/api/audit-address';
import { writeFinding } from '@/api/finding-writes';
import type { ApiDeps, FindingAction } from '@/api/finding-writes';
import type { FindingJson } from '@hushbox/docket';

interface PaneWritesOptions {
  readonly put: (finding: FindingJson) => void;
  readonly api?: ApiDeps;
}

export interface PaneWrites {
  /** Resolves to whether the write landed, so a bulk caller can count. */
  readonly run: (finding: FindingJson, action: FindingAction, body: object) => Promise<boolean>;
  readonly errorFor: (id: string) => string | null;
}

interface WriteFailure {
  readonly id: string;
  readonly message: string;
}

/**
 * Every write the review panes make. They are not optimistic the way the ruling
 * loop is: nothing here advances a queue, so the file is the record and the
 * pane shows what the server hands back. It writes through the console's one
 * transport, which is what makes a held-lock refusal a retry rather than an
 * error the reader has to understand.
 */
export function usePaneWrites({ put, api }: PaneWritesOptions): PaneWrites {
  const audit = useAuditAddress();
  const [failure, setFailure] = useState<WriteFailure | null>(null);

  const run = useCallback(
    async (finding: FindingJson, action: FindingAction, body: object): Promise<boolean> => {
      setFailure(null);
      const outcome = await writeFinding(
        { audit: audit, finding: finding, action: action, body: body },
        api
      );
      if (!outcome.ok) {
        setFailure({ id: finding.id, message: outcome.message });
        return false;
      }
      put(outcome.value.finding);
      return true;
    },
    [api, audit, put]
  );

  const errorFor = useCallback(
    (id: string): string | null => (failure?.id === id ? failure.message : null),
    [failure]
  );

  return { run, errorFor };
}
