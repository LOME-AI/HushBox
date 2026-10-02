import * as React from 'react';
import { Button, ScrollRegion } from '@hushbox/ui';
import { formatVisitorCount } from './funnel-math.js';
import { summedCountLabel } from './summed-label.js';
import type { GrowthEventRowWire } from '@hushbox/shared';

/** One named event on one page, summed over the hours in the window. */
export interface EventTotal {
  readonly eventName: string;
  readonly path: string;
  readonly visitors: number;
  readonly overflow: boolean;
}

/** What the table holds, as its caption and as the name of the box it scrolls in. */
const TABLE_CAPTION = 'Named events by page';

/** A separator no event name or path can contain, so two pairs never share a key. */
const KEY_SEPARATOR = '\u0000';

/**
 * Events summed per name and page. Each hour is its own set, so a visitor who
 * came back in a later hour counts in both — the figure is a sum of hourly
 * counts, which is what the column heading says.
 */
export function eventTotals(rows: readonly GrowthEventRowWire[]): readonly EventTotal[] {
  const totals = new Map<string, EventTotal>();
  for (const row of rows) {
    const key = [row.eventName, row.path].join(KEY_SEPARATOR);
    const seen = totals.get(key);
    totals.set(key, {
      eventName: row.eventName,
      path: row.path,
      visitors: (seen?.visitors ?? 0) + row.visitors,
      overflow: (seen?.overflow ?? false) || row.overflow,
    });
  }
  return [...totals.values()].toSorted((left, right) => right.visitors - left.visitors);
}

/**
 * Named events, one page of hourly rows at a time. The server states whether
 * another page follows; nothing here infers it from the row count, which would
 * be wrong on the page that happens to fill exactly.
 *
 * What the rows cover under the page's campaign selection is stated by the panel
 * frame from the scope the screen declares, as it is for every other panel.
 */
export function EventsPanel({
  rows,
  page,
  hasMore,
  onPageChange,
}: Readonly<{
  readonly rows: readonly GrowthEventRowWire[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly onPageChange: (page: number) => void;
}>): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No named events in this range.</p>;
  }
  const totals = eventTotals(rows);

  return (
    <div>
      <ScrollRegion label={TABLE_CAPTION} className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{TABLE_CAPTION}</caption>
          <thead>
            <tr className="text-muted-foreground text-xs uppercase">
              <th scope="col" className="py-1 pr-2 font-semibold">
                Event
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Page
              </th>
              <th scope="col" className="py-1 pl-2 text-right font-semibold">
                {summedCountLabel('People', 'hourly')}
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.map((total) => (
              <tr key={`${total.eventName} ${total.path}`} className="border-border border-b">
                <td className="py-1 pr-2 font-mono text-xs">{total.eventName}</td>
                <td className="py-1 pr-2 font-mono text-xs">{total.path}</td>
                <td className="py-1 pl-2 text-right tabular-nums">
                  {formatVisitorCount(total.visitors, total.overflow)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <div className="mt-2 flex gap-2">
        {page > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onPageChange(page - 1);
            }}
          >
            Previous page
          </Button>
        )}
        {hasMore && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onPageChange(page + 1);
            }}
          >
            Next page
          </Button>
        )}
      </div>
    </div>
  );
}
