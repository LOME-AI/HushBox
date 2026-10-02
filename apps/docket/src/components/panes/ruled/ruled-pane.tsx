import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { orderByMostRecentAction } from '../decided-order';
import { usePaneWrites } from '../pane-writes';
import { useFocusedRow } from '../use-focused-row';
import { RuledRow } from './ruled-row';
import { useBriefCopy } from './use-brief-copy';
import type { ApiDeps } from '@/api/finding-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface RuledPaneProps {
  /** The ruled findings the filters admit, which is also what the brief covers. */
  readonly findings: readonly FindingJson[];
  readonly put: (finding: FindingJson) => void;
  /**
   * The finding the url names, marked and scrolled back into view. Required
   * rather than optional: the registry that mounts this pane always has one, so
   * an absent `focus` is a broken wire rather than a legitimate state, and
   * optional would let that wire go dead without failing anything.
   */
  readonly focus: string | null;
  readonly api?: ApiDeps;
  readonly briefFetch?: typeof globalThis.fetch;
}

const COPY_LABEL: Record<string, string> = {
  working: 'Building brief',
  copied: 'Copied',
};

/**
 * What has been decided, newest first, and the way to hand it to an
 * implementation agent. The brief covers the filtered set rather than the whole
 * audit, so narrowing to one area hands over that area's work and nothing else.
 */
export function RuledPane({ findings, put, focus, api, briefFetch }: RuledPaneProps): JSX.Element {
  const writes = usePaneWrites(api === undefined ? { put } : { put, api });
  const brief = useBriefCopy(briefFetch === undefined ? {} : { fetch: briefFetch });
  const ordered = orderByMostRecentAction(findings);
  const focusedRow = useFocusedRow('ruled', focus);

  return (
    <div data-testid={TEST_IDS.ruledPane} className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          data-testid={TEST_IDS.ruledBriefCopy}
          disabled={brief.status === 'working'}
          onClick={() => {
            void brief.copy(ordered);
          }}
        >
          {COPY_LABEL[brief.status] ?? `Copy brief for ${String(ordered.length)}`}
        </Button>
        {brief.message !== null && (
          <span role="alert" className="text-destructive text-sm">
            {brief.message}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {ordered.map((finding) => (
          <RuledRow
            key={finding.id}
            {...(finding.id === focus ? { ref: focusedRow } : {})}
            finding={finding}
            selected={finding.id === focus}
            writes={writes}
          />
        ))}
      </div>
    </div>
  );
}
