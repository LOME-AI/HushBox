import { useCallback, useState } from 'react';
import type { FindingJson } from '@hushbox/docket';

interface FindingStore {
  readonly findings: readonly FindingJson[];
  /** Puts one finding back in place, by id. Order never moves. */
  readonly put: (finding: FindingJson) => void;
}

/**
 * The audit as the reader currently sees it. Every write returns the finding it
 * produced, so a ruling patches one entry rather than refetching two megabytes
 * of audit, and the optimistic move and the server's answer take the same door.
 */
export function useFindingStore(initial: readonly FindingJson[]): FindingStore {
  const [findings, setFindings] = useState(initial);
  const [seed, setSeed] = useState(initial);

  if (seed !== initial) {
    setSeed(initial);
    setFindings(initial);
  }

  const put = useCallback((next: FindingJson): void => {
    setFindings((current) => current.map((finding) => (finding.id === next.id ? next : finding)));
  }, []);

  return { findings, put };
}
