import * as React from 'react';
import { ScrollRegion } from '@hushbox/ui';
import { NO_COUNT } from './absent-figure.js';
import { formatVisitorCount } from './funnel-math.js';
import { summedCountLabel } from './summed-label.js';
import type { MarketingTotal } from './marketing-rows.js';
import type { SummedBucketing } from './summed-label.js';

/** What this table is, wherever it is named: its caption and its scroll box. */
const TABLE_CAPTION = 'Pages by visitors and landings';

/**
 * How the column names stay put while the rows scroll under them.
 *
 * The bound below is what makes this load-bearing rather than decoration: a
 * figure read halfway down a scrolled box with its column name off the top is a
 * figure whose name the reader has to remember.
 */
const STICKY_HEADING = 'bg-card sticky top-0 py-1 font-semibold';

/** What this table's columns are called, on screen and in the exported file. */
export interface PageColumnHeaders {
  readonly path: string;
  readonly visitors: string;
  readonly landings: string;
}

/**
 * The column names, from one definition the table and the export both read.
 * Two spellings of one figure read as two figures, so neither surface writes
 * its own.
 */
export function pageColumnHeaders(bucketing: SummedBucketing): PageColumnHeaders {
  return {
    path: 'Path',
    visitors: summedCountLabel('Visitors', bucketing),
    landings: summedCountLabel('Landings', bucketing),
  };
}

/**
 * Pages by visitors, with the landings the path family carries.
 *
 * A page whose landing figure is absent says so in words rather than showing a
 * zero: the family did not carry the number for those buckets, which is not a
 * claim that nobody arrived there first.
 */
export function PagesPanel({
  totals,
  bucketing,
}: Readonly<{
  readonly totals: readonly MarketingTotal[];
  readonly bucketing: SummedBucketing;
}>): React.JSX.Element {
  const [leader] = totals;
  if (leader === undefined) {
    return <p className="text-muted-foreground text-sm">Nothing was counted in this range.</p>;
  }
  const headers = pageColumnHeaders(bucketing);
  return (
    <figure className="m-0">
      <ScrollRegion
        data-slot="pages-scrollport"
        label={TABLE_CAPTION}
        // The bound is in rem so it grows with the font-scaling tier, which an
        // absolute height would not. It holds every row: nothing is dropped, so
        // the caption below states the count the box scrolls through.
        className="max-h-96 overflow-auto rounded-sm"
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{TABLE_CAPTION}</caption>
          <thead>
            <tr className="text-muted-foreground text-xs uppercase">
              <th scope="col" className={`${STICKY_HEADING} pr-2`}>
                {headers.path}
              </th>
              <th scope="col" className={`${STICKY_HEADING} pl-2 text-right`}>
                {headers.visitors}
              </th>
              <th scope="col" className={`${STICKY_HEADING} pl-2 text-right`}>
                {headers.landings}
              </th>
            </tr>
          </thead>
          <tbody>
            {totals.map((total) => (
              <tr key={total.key} className="border-border border-b">
                <td className="py-1 pr-2 font-mono text-xs">{total.key}</td>
                <td className="py-1 pl-2 text-right tabular-nums">
                  {formatVisitorCount(total.visitors, total.overflow)}
                </td>
                <td className="py-1 pl-2 text-right tabular-nums">
                  {total.landings === null || total.landings === undefined
                    ? NO_COUNT
                    : formatVisitorCount(total.landings, total.overflow)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <figcaption className="text-muted-foreground mt-2 text-xs">
        {`${leader.key} was counted most. All ${String(totals.length)} pages counted are listed.`} A
        landing is a visit that began on the page rather than arriving at it from another one, so a
        page can be counted far more often than it is landed on.
      </figcaption>
    </figure>
  );
}
