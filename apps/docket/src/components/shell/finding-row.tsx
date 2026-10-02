import { memo } from 'react';
import { cn } from '@hushbox/ui';
import { Badge } from '@hushbox/ui/marks';
import { FindingTitle } from '@/components/finding/finding-title';
import { TEST_IDS } from '@/test-ids';
import { SeverityBadge } from './severity-badge';
import type { FindingJson } from '@hushbox/docket';
import type { JSX, Ref } from 'react';

interface FindingRowProps {
  readonly finding: FindingJson;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** Set on the selected row only, so the pane can bring it back into view. */
  readonly ref?: Ref<HTMLLIElement>;
}

/**
 * One line of the queue. Titles are not guaranteed short: the migrated corpus
 * carries several hundred characters in a single title, so the row clamps and
 * breaks rather than assuming a sentence.
 *
 * Memoized: a search keystroke narrows a queue of several hundred, and the rows
 * that survive it are the same rows with the same props.
 */
function Row({ finding, selected, onSelect, ref }: FindingRowProps): JSX.Element {
  return (
    <li ref={ref}>
      <button
        type="button"
        data-testid={TEST_IDS.findingRow}
        {...(selected ? { 'aria-current': 'true' as const } : {})}
        onClick={() => {
          onSelect(finding.id);
        }}
        className={cn(
          // The selected tint alone sits at 1.16:1 against an unselected row and
          // a hover tint lands between the two, so the state carries a
          // full-contrast rule down the leading edge instead. Every row reserves
          // it, or selecting one would shift its text by the rule's width.
          // The rule is --brand-red over --background-subtle, which clears SC
          // 1.4.11 by 0.06 in light; that floor is pinned in
          // apps/admin/src/lib/theme-contrast.test.ts.
          'border-border/60 focus-visible:ring-ring hover:bg-muted/60 w-full border-b border-l-4 border-l-transparent px-3 py-2 text-left outline-none focus-visible:ring-2',
          selected && 'border-l-primary bg-muted'
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-foreground font-mono text-sm">{finding.id}</span>
          <SeverityBadge severity={finding.severity} />
          {finding.warning && <Badge tone="error">warning</Badge>}
          {finding.group !== null && (
            <Badge tone="neutral">
              <span className="font-mono">{finding.group}</span>
            </Badge>
          )}
        </span>
        {/* No display utility beside the clamp: `line-clamp-2` sets its own
            display, and overriding it silently un-clamps the longest titles. */}
        <FindingTitle
          as="span"
          className="text-foreground mt-1 line-clamp-2 text-sm break-words"
          html={finding.titleHtml}
        />
        <span className="text-muted-foreground mt-1 flex gap-3 text-sm">
          <span>{finding.status}</span>
          <span>{finding.kind}</span>
          <span className="truncate font-mono">{finding.area}</span>
        </span>
      </button>
    </li>
  );
}

export const FindingRow = memo(Row);
