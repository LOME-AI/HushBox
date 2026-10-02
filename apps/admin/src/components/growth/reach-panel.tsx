import * as React from 'react';
import { ScrollRegion } from '@hushbox/ui';
import { NO_COUNT } from './absent-figure.js';
import { formatRate } from './format-rate.js';
import { formatVisitorCount } from './funnel-math.js';
import { LOWER_BOUND_NOTE, summedCountLabel } from './summed-label.js';
import type { GrowthReachRowWire } from '@hushbox/shared';

/** What this table is, wherever it is named: its caption and its scroll box. */
const TABLE_CAPTION = 'Visitors who landed on one page and reached another the same day';

/** What each column holds, from one definition the header row reads. */
const COLUMNS = {
  landing: 'Landing',
  reached: 'Then reached',
  visitors: summedCountLabel('Visitors', 'daily'),
  share: 'Of landing',
} as const;

/**
 * How the column names stay put while the rows scroll under them.
 *
 * The bound below is what makes this load-bearing rather than decoration: a
 * figure read halfway down a scrolled box with its column name off the top is
 * a figure whose name the reader has to remember.
 */
const STICKY_HEADING = 'bg-card sticky top-0 py-1 font-semibold';

/** One landing's own visitor count, as the pair it makes with itself carries it. */
interface Landed {
  readonly visitors: number;
  readonly overflow: boolean;
}

/** The journeys made from one landing page, with that landing's own figure. */
interface ReachGroup {
  readonly landingPath: string;
  /**
   * Visitors counted landing on this page, or null where the read carried no
   * pair of the page with itself. Null rather than a zero: the count is one the
   * read did not carry, which is not a claim that nobody landed there.
   */
  readonly landed: Landed | null;
  /** Every pair from this landing, the one with itself included, largest first. */
  readonly rows: readonly GrowthReachRowWire[];
}

/**
 * What a group is ordered by: its landing's own visitors, and below every one
 * of them a landing whose own count the read did not carry — ordered last
 * rather than as a zero, because nothing here knows how large it was.
 */
function orderingWeight(group: ReachGroup): number {
  return group.landed?.visitors ?? -1;
}

/**
 * The read's rows gathered by landing page, each group carrying that landing's
 * own visitor count.
 *
 * That count is the pair a landing makes with itself, which the counting script
 * fills for every visitor's first page of the day
 * (`apps/api/src/slices/growth/domain/count-beacon.ts` keys the reach set by
 * the pair of the landing and the page reached). So the trivial-looking rows
 * are the only place the denominator of every other row in the group exists,
 * which is why folding them away is a control rather than a filter.
 */
function groupByLanding(rows: readonly GrowthReachRowWire[]): readonly ReachGroup[] {
  const byLanding = new Map<string, GrowthReachRowWire[]>();
  for (const row of rows) {
    const held = byLanding.get(row.landingPath);
    if (held === undefined) byLanding.set(row.landingPath, [row]);
    else held.push(row);
  }
  return [...byLanding.entries()]
    .map(([landingPath, group]) => {
      const self = group.find((row) => row.reachedPath === landingPath);
      return {
        landingPath,
        landed:
          self === undefined
            ? null
            : { visitors: self.visitorsDailySummed, overflow: self.overflow },
        rows: group.toSorted((left, right) => right.visitorsDailySummed - left.visitorsDailySummed),
      };
    })
    .toSorted(
      (left, right) =>
        orderingWeight(right) - orderingWeight(left) ||
        left.landingPath.localeCompare(right.landingPath)
    );
}

/**
 * One journey as a share of its landing's own visitors, or that there is no
 * rate to state.
 *
 * Both figures sum each day's own distinct count, so both are lower bounds, and
 * a ratio of two lower bounds is uncertain in neither direction in particular:
 * a ceiling on either side could have moved it up or down. There is no figure
 * that ratio supports, so none is printed.
 */
function shareOfLanding(row: GrowthReachRowWire, landed: Landed | null): string {
  if (landed === null || landed.visitors === 0) return formatRate(null);
  if (landed.overflow || row.overflow) return formatRate(null);
  return formatRate(row.visitorsDailySummed / landed.visitors);
}

/** A landing's own figure as the group states it, absent or not. */
function landedNote(landed: Landed | null): string {
  return `Landed: ${landed === null ? NO_COUNT : formatVisitorCount(landed.visitors, landed.overflow)}`;
}

/** What the fold has done, in one sentence that needs no interaction to read. */
function foldNote(selfPairs: number, shown: boolean): string {
  if (selfPairs === 0) return 'No pair here has the landing as the page reached.';
  const state = shown ? 'shown' : 'folded away';
  return `Pairs where the landing is the page reached are ${state} (${String(selfPairs)}).`;
}

/**
 * Same-day journeys from a landing page to another page, grouped by the landing
 * and bounded to a box that scrolls.
 *
 * A pair the read did not carry is left out entirely. The table holds a row per
 * journey somebody was counted making, so an absent pair means nobody was
 * counted making it — which is not the same fact as a count of zero, and
 * filling the grid in would turn "we did not measure this" into "this did not
 * happen". Nothing here completes a range or squares off a matrix.
 */
export function ReachPanel({
  rows,
}: Readonly<{ rows: readonly GrowthReachRowWire[] }>): React.JSX.Element {
  const [selfShown, setSelfShown] = React.useState(false);

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No journeys were counted in this range.</p>;
  }
  const groups = groupByLanding(rows);
  const selfPairs = rows.filter((row) => row.reachedPath === row.landingPath).length;
  const drawn = groups
    .map((group) => ({
      group,
      rows: selfShown
        ? group.rows
        : group.rows.filter((row) => row.reachedPath !== group.landingPath),
    }))
    // A landing whose only pair is with itself has no journey to list while
    // that pair is folded; the note above the table is what accounts for it,
    // and the control is what brings it back.
    .filter((entry) => entry.rows.length > 0);

  return (
    <figure className="m-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p data-slot="reach-fold-note" className="text-muted-foreground min-w-0 text-xs">
          {foldNote(selfPairs, selfShown)}
        </p>
        {selfPairs > 0 && (
          <button
            type="button"
            aria-pressed={selfShown}
            className="text-muted-foreground hover:text-foreground min-w-0 text-left text-xs underline"
            onClick={() => {
              setSelfShown((shown) => !shown);
            }}
          >
            {selfShown ? 'Hide' : 'Show'} pairs where the landing is the page reached
          </button>
        )}
      </div>
      <ScrollRegion
        data-slot="reach-scrollport"
        label={TABLE_CAPTION}
        // The bound is in rem so it grows with the font-scaling tier, which an
        // absolute height would not.
        className="max-h-96 overflow-auto rounded-sm"
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{TABLE_CAPTION}</caption>
          <thead>
            <tr className="text-muted-foreground text-xs uppercase">
              <th scope="col" className={`${STICKY_HEADING} pr-2`}>
                {COLUMNS.landing}
              </th>
              <th scope="col" className={`${STICKY_HEADING} pr-2`}>
                {COLUMNS.reached}
              </th>
              <th scope="col" className={`${STICKY_HEADING} pl-2 text-right`}>
                {COLUMNS.visitors}
              </th>
              <th scope="col" className={`${STICKY_HEADING} pl-2 text-right`}>
                {COLUMNS.share}
              </th>
            </tr>
          </thead>
          {drawn.map(({ group, rows: journeys }) => (
            <tbody key={group.landingPath}>
              {journeys.map((row, index) => (
                <tr key={row.reachedPath} className="border-border border-b">
                  {index === 0 && (
                    <th
                      scope="rowgroup"
                      rowSpan={journeys.length}
                      className="border-border border-b py-1 pr-2 align-top font-mono text-xs font-normal"
                    >
                      {group.landingPath}
                      <span className="text-muted-foreground block font-sans text-xs font-normal">
                        {landedNote(group.landed)}
                      </span>
                    </th>
                  )}
                  <td className="py-1 pr-2 font-mono text-xs">{row.reachedPath}</td>
                  <td className="py-1 pl-2 text-right tabular-nums">
                    {formatVisitorCount(row.visitorsDailySummed, row.overflow)}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums">
                    {shareOfLanding(row, group.landed)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </ScrollRegion>
      <figcaption className="text-muted-foreground mt-2 text-xs">
        {LOWER_BOUND_NOTE} Pairs nobody was counted making carry no row. Percentages are of that
        landing&apos;s own visitors, and are left unstated where either figure hit a counting
        ceiling.
      </figcaption>
    </figure>
  );
}
