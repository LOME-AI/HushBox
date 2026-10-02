import { TEST_IDS } from '@/test-ids';
import { STATUS_LABELS, boardColumns } from './board-order';
import { ProgressCard } from './progress-card';
import { useProgressActions } from './use-progress-actions';
import type { ApiDeps } from '@/api/finding-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface ProgressBoardProps {
  /** The ruled findings the filters admit: only a ruling can be worked on. */
  readonly findings: readonly FindingJson[];
  readonly put: (finding: FindingJson) => void;
  readonly api?: ApiDeps;
}

export function ProgressBoard({ findings, put, api }: ProgressBoardProps): JSX.Element {
  const actions = useProgressActions(api === undefined ? { put } : { put, api });

  return (
    <div
      data-testid={TEST_IDS.progressBoard}
      className="grid items-start gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {boardColumns(findings).map((column) => (
        <section
          key={column.status}
          data-testid={TEST_IDS.progressColumn}
          className="flex flex-col gap-2"
        >
          <h3 className="text-muted-foreground flex items-baseline gap-2 text-sm font-semibold uppercase">
            {STATUS_LABELS[column.status]}
            <span className="font-mono tabular-nums">{column.findings.length}</span>
          </h3>
          {column.findings.map((finding) => (
            <ProgressCard key={finding.id} finding={finding} actions={actions} />
          ))}
        </section>
      ))}
    </div>
  );
}
