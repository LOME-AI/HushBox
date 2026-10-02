import { TEST_IDS } from '@/test-ids';
import { usePaneWrites } from '../pane-writes';
import { useFocusedRow } from '../use-focused-row';
import { deniedGroups } from './denied-groups';
import { DeniedRow } from './denied-row';
import type { ApiDeps } from '@/api/finding-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface DeniedPaneProps {
  /** The denied findings the filters admit. */
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
}

/**
 * Two different things end up denied: what the reader refused, and what the
 * audit refuted before anybody opened the console. Reading them as one list
 * would make somebody's own decision look like the audit's, so the pane keeps
 * them apart and shows the reason each carries.
 */
export function DeniedPane({ findings, put, focus, api }: DeniedPaneProps): JSX.Element {
  const writes = usePaneWrites(api === undefined ? { put } : { put, api });
  const focusedRow = useFocusedRow('denied', focus);

  return (
    <div data-testid={TEST_IDS.deniedPane} className="flex flex-col gap-5 p-4">
      {deniedGroups(findings).map((group) => (
        <section key={group.by} data-testid={TEST_IDS.deniedGroup} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground flex items-baseline gap-2 text-sm font-semibold uppercase">
            {group.label}
            <span className="font-mono tabular-nums">{group.findings.length}</span>
          </h3>
          {group.findings.map((finding) => (
            <DeniedRow
              key={finding.id}
              {...(finding.id === focus ? { ref: focusedRow } : {})}
              finding={finding}
              selected={finding.id === focus}
              writes={writes}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
