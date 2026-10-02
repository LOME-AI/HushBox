import { Badge } from '@hushbox/ui/marks';
import { TEST_IDS } from '@/test-ids';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface FindingChipsProps {
  readonly label: string;
  readonly ids: readonly string[];
  readonly findings: readonly FindingJson[];
  readonly onJump: (id: string) => void;
}

/**
 * The other findings this one is tied to, as one step away. An id the audit no
 * longer holds still shows, because knowing the reference is dangling is worth
 * more than hiding it.
 */
export function FindingChips({
  label,
  ids,
  findings,
  onJump,
}: FindingChipsProps): JSX.Element | null {
  if (ids.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm font-semibold uppercase">{label}</span>
      {ids.map((id) => {
        const target = findings.find((finding) => finding.id === id);
        if (target === undefined) {
          return (
            <Badge key={id} tone="neutral">
              <span className="font-mono">{id}</span>
            </Badge>
          );
        }
        return (
          <button
            key={id}
            type="button"
            data-testid={TEST_IDS.findingChip}
            onClick={() => {
              onJump(id);
            }}
            className="border-border focus-visible:ring-ring hover:bg-muted flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm outline-none focus-visible:ring-2"
          >
            <span className="font-mono">{id}</span>
            <span className="text-muted-foreground">{target.state}</span>
          </button>
        );
      })}
    </div>
  );
}
