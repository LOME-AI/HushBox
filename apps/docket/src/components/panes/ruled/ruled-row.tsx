import { cn } from '@hushbox/ui';
import { FindingHtml } from '@/components/finding/finding-html';
import { FindingTitle } from '@/components/finding/finding-title';
import { decided } from '@/components/finding/decision-summary';
import { SeverityBadge } from '@/components/shell/severity-badge';
import { TEST_IDS } from '@/test-ids';
import { STATUS_LABELS } from '../progress/board-order';
import { ReopenButton } from '../reopen-button';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX, Ref } from 'react';

interface RuledRowProps {
  readonly finding: FindingJson;
  readonly writes: PaneWrites;
  /** The row the reader is on, which the pane also scrolls back into view. */
  readonly selected?: boolean;
  /** Set on the selected row only, so the pane has something to scroll to. */
  readonly ref?: Ref<HTMLElement>;
}

export function RuledRow({ finding, writes, selected = false, ref }: RuledRowProps): JSX.Element {
  const { ruling } = finding;

  return (
    <article
      ref={ref}
      data-testid={TEST_IDS.ruledRow}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      className={cn(
        'border-border bg-card flex flex-col gap-2 rounded-md border p-3',
        selected && 'border-ring bg-muted'
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-foreground font-mono text-sm">{finding.id}</span>
        <SeverityBadge severity={finding.severity} />
        <span className="text-muted-foreground font-mono text-sm break-all">{finding.area}</span>
        <span className="text-muted-foreground text-sm">
          {STATUS_LABELS[finding.progress.status]}
        </span>
      </div>

      <FindingTitle
        className="text-foreground max-w-prose text-sm break-words"
        html={finding.titleHtml}
      />

      {ruling === null ? (
        <p className="text-muted-foreground text-sm">No ruling recorded</p>
      ) : (
        <div className="flex max-w-prose flex-col gap-1">
          <p className="text-foreground text-sm break-words">{decided(ruling, finding)}</p>
          {ruling.note !== null && (
            <p className="text-muted-foreground text-sm break-words">{ruling.note}</p>
          )}
        </div>
      )}

      <details className="max-w-prose">
        <summary className="text-muted-foreground cursor-pointer text-sm">Read the finding</summary>
        <FindingHtml html={finding.bodyHtml} />
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <ReopenButton finding={finding} writes={writes} />
      </div>
    </article>
  );
}
