import { cn } from '@hushbox/ui';
import { FindingHtml } from '@/components/finding/finding-html';
import { FindingTitle } from '@/components/finding/finding-title';
import { SeverityBadge } from '@/components/shell/severity-badge';
import { TEST_IDS } from '@/test-ids';
import { ReopenButton } from '../reopen-button';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX, Ref } from 'react';

interface DeniedRowProps {
  readonly finding: FindingJson;
  readonly writes: PaneWrites;
  /** The row the reader is on, which the pane also scrolls back into view. */
  readonly selected?: boolean;
  /** Set on the selected row only, so the pane has something to scroll to. */
  readonly ref?: Ref<HTMLElement>;
}

export function DeniedRow({ finding, writes, selected = false, ref }: DeniedRowProps): JSX.Element {
  const reason = finding.denial?.reason ?? null;

  return (
    <article
      ref={ref}
      data-testid={TEST_IDS.deniedRow}
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
      </div>

      <FindingTitle
        className="text-foreground max-w-prose text-sm break-words"
        html={finding.titleHtml}
      />

      {reason === null ? (
        <p className="text-muted-foreground text-sm">No reason recorded</p>
      ) : (
        <p className="text-foreground max-w-prose text-sm break-words">{reason}</p>
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
