import { Badge } from '@hushbox/ui/marks';
import { FindingTitle } from '@/components/finding/finding-title';
import { TEST_IDS } from '@/test-ids';
import { SeverityBadge } from './severity-badge';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

/**
 * The audit writes `status_note` as the rest of the sentence the status opens,
 * so the two are rendered as one run: a note its author began with punctuation
 * joins with no gap, anything else with a non-breaking space. The space is
 * non-breaking because the note is a flex item, so an ordinary leading space
 * collapses away and leaves the status and its note touching.
 */
function afterStatus(note: string): string {
  return /^[.,]/u.test(note) ? note : `\u{A0}${note}`;
}

/**
 * The frame the reader works inside while ruling one finding at a time: what
 * the finding is, before anything that acts on it.
 */
export function FocusedFinding({ finding }: Readonly<{ finding: FindingJson }>): JSX.Element {
  return (
    <article data-testid={TEST_IDS.focusedFinding} className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-mono text-sm">{finding.id}</span>
        <SeverityBadge severity={finding.severity} />
        <span data-slot="status" className="flex min-w-0 flex-wrap items-baseline">
          <Badge tone="neutral">{finding.status}</Badge>
          {finding.statusNote !== null && (
            <span data-slot="status-note" className="text-muted-foreground text-sm break-words">
              {afterStatus(finding.statusNote)}
            </span>
          )}
        </span>
        <Badge tone="neutral">{finding.kind}</Badge>
        {finding.warning && <Badge tone="error">warning</Badge>}
      </div>
      {/* The measure is the column the card puts this in, which is already half
          a viewport: a cap of its own would take the width back off it. */}
      <FindingTitle
        as="h2"
        className="text-foreground text-2xl leading-snug font-semibold break-words"
        html={finding.titleHtml}
      />
      <p className="text-muted-foreground font-mono text-sm break-words">{finding.area}</p>
    </article>
  );
}
