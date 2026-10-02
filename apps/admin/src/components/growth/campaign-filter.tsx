import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { CheckField } from '@hushbox/ui/field';
import { Popover } from '@hushbox/ui/popover';
import type { GrowthCampaignWire } from '@hushbox/shared';

/**
 * What the trigger says the selection covers, so the list stays closed to read
 * it. Exported because the toolbar's disclosure states the same count while it
 * holds this trigger folded away, and two phrasings of one count would read as
 * two different counts.
 */
export function countLabel(campaigns: number, selected: number): string {
  if (campaigns === 0) return 'No campaigns';
  if (selected === 0) return `All ${String(campaigns)}`;
  return `${String(selected)} of ${String(campaigns)}`;
}

/**
 * Which campaigns the page is scoped to, behind one trigger that states how
 * many of them the selection names.
 *
 * A multi-select rather than a per-tag read: the ladder read returns every
 * campaign's weeks in one response, so the panels built on it are narrowed here
 * without asking the server again. The named-events read is the exception and
 * is not free — it takes a single tag, so a selection of exactly one campaign
 * changes its query key in `use-growth-reads.ts` and spends another read
 * against the actor's hourly operations budget.
 */
export function CampaignFilter({
  campaigns,
  selected,
  onToggle,
}: Readonly<{
  readonly campaigns: readonly GrowthCampaignWire[];
  readonly selected: readonly string[];
  readonly onToggle: (tag: string, chosen: boolean) => void;
}>): React.JSX.Element {
  const labelId = React.useId();
  const countId = React.useId();

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-muted-foreground text-xs">
        Campaigns
      </span>
      <Popover
        title="Campaigns"
        align="start"
        trigger={
          <Button
            variant="bare"
            aria-labelledby={`${labelId} ${countId}`}
            className="border-border bg-card hover:border-border-strong focus-visible:border-ring flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm"
          >
            <span id={countId}>{countLabel(campaigns.length, selected.length)}</span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground size-3.5" />
          </Button>
        }
      >
        <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
          {campaigns.map((row) => (
            <CheckField
              key={row.tag}
              checked={selected.includes(row.tag)}
              onCheckedChange={(chosen) => {
                onToggle(row.tag, chosen);
              }}
              label={row.tag}
            />
          ))}
        </div>
      </Popover>
    </div>
  );
}
