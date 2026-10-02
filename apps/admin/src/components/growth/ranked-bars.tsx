import * as React from 'react';
import { DataDisclosure } from './data-disclosure.js';
import { formatRate } from './format-rate.js';
import { formatVisitorCount } from './funnel-math.js';
import { chartDatumLabel } from './summed-label.js';
import type { MarketingTotal } from './marketing-rows.js';
import type { SummedFigureLabel } from './summed-label.js';

/** Rows shown before the reader asks for the rest, so a long tail cannot bury the panel. */
const COLLAPSED_ROWS = 10;

/** What the first column holds, where nothing narrower than a key is known about it. */
const DEFAULT_KEY_HEADER = 'Name';

/** What the share column holds, on screen and in this panel's own table. */
const SHARE_HEADER = 'Share';

/**
 * Everything the ranking counted, and whether any part of it hit a ceiling.
 *
 * It is the denominator every share on the panel is taken against, so it adds
 * every entry rather than the rows the collapse shows: a share of the visible
 * ten would move when the reader asked for the rest, which is a different
 * figure wearing the same label.
 */
function countedAcross(totals: readonly MarketingTotal[]): {
  readonly visitors: number;
  readonly overflow: boolean;
} {
  return {
    visitors: totals.reduce((sum, total) => sum + total.visitors, 0),
    overflow: totals.some((total) => total.overflow),
  };
}

/**
 * One entry's share of everything counted, or that there is no rate to state.
 *
 * Nothing counted leaves the share nothing to be taken against, which is the
 * one case a nought would misreport: `0.0%` is a share these rows can carry and
 * it says the entry was counted and came to none of the total.
 */
function shareOfCounted(visitors: number, counted: number): string {
  return formatRate(counted === 0 ? null : visitors / counted);
}

/**
 * Every figure one row draws, in words: the row is a tab stop whose name is all
 * a keyboard reader hears of it, and the bar behind it carries no figure a
 * reader can take off it.
 */
function rowName(total: MarketingTotal, countLabel: SummedFigureLabel, share: string): string {
  return [
    `${chartDatumLabel(total.key, countLabel, formatVisitorCount(total.visitors, total.overflow))}.`,
    `${SHARE_HEADER}: ${share}.`,
  ].join(' ');
}

/**
 * The ranking in one sentence, followed by what its figures are.
 *
 * It names what leads *of what was counted* rather than what leads outright:
 * each figure adds per-bucket distinct counts, so every one of them is a lower
 * bound and an ordering of lower bounds is an ordering of the counting, not of
 * the world.
 */
function rankingInsight(totals: readonly MarketingTotal[], leader: MarketingTotal): string {
  const runnerUp = totals[1];
  const lead =
    runnerUp === undefined
      ? `${leader.key} was counted most, and nothing else was counted in this range.`
      : `${leader.key} was counted most, ahead of ${runnerUp.key}.`;
  const counted = countedAcross(totals);
  const denominator = formatVisitorCount(counted.visitors, counted.overflow);
  return `${lead} Each figure adds that name's buckets together, so a visitor counted in two of them counts in each. Shares are of the ${denominator} counted in this range, added across every row.`;
}

/**
 * One row of a ranking: a bar sized against the leader, drawn behind the row's
 * own cells.
 *
 * Exported because two panels on this screen rank the same way, and a second
 * spelling of the bar's placement, the row's ink and its tab stop would be two
 * appearances of one thing. What a ranking puts beside its label differs per
 * panel, so the cells and the grid that sizes them stay the caller's.
 */
export function RankedRow({
  fillPercent,
  accessibleName,
  className,
  children,
}: Readonly<{
  /** How much of the row the bar covers, as a percentage of the leader's figure. */
  readonly fillPercent: number;
  /** Everything the row draws, in words, because the bar itself is not readable. */
  readonly accessibleName: string;
  /** The row's own grid: the tracks the caller's cells are sized by. */
  readonly className: string;
  readonly children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <li
      // A chart's bars are data, not controls, and the accessible pattern for one
      // is a tab stop per bar carrying the figure as its name — the approach the
      // WAI charting guidance and Highcharts' accessibility module both take.
      // Without it a keyboard reader cannot walk the chart at all.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- data tab stop, per the comment above
      tabIndex={0}
      aria-label={accessibleName}
      // The ink is the ramp's own text partner rather than the page's body ink,
      // because part of every label sits on the fill behind it: a contrast tier
      // restates the body ink while no tier derives the ramp, so the two close on
      // each other at the deeper steps. The reasoning is on --seq-foreground in
      // `packages/config/tailwind/index.css`, and the partner clears the floor on
      // the card as well as on the fill.
      //
      // The caller's tracks take a zero minimum and its label may shrink to
      // nothing: a track carrying an implicit min-content floor is what puts a row
      // wider than its panel at a scaled font size.
      className={`focus-visible:ring-ring text-seq-foreground relative grid items-center gap-2 overflow-hidden rounded-sm px-1 py-1 text-sm focus-visible:ring-2 focus-visible:outline-hidden ${className}`}
    >
      <span
        data-slot="ranked-bar"
        // Drawn first so the row's own text, which follows it, paints over it:
        // both are positioned, so paint order is document order and moving this
        // span after the cells would bury them.
        aria-hidden="true"
        // The only per-row value a utility class cannot carry; the colour itself
        // comes from a ramp token through the class.
        style={{ width: `${String(fillPercent)}%` }}
        className="bg-seq-2 absolute inset-y-0 left-0"
      />
      {children}
    </li>
  );
}

/**
 * A sorted list of labelled bars — the form a ranked breakdown reads best in,
 * and the one that needs no plotting library: each bar is a box whose width is
 * a percentage, with the figure printed beside it rather than encoded only in
 * the length.
 */
export function RankedBars({
  totals,
  countLabel,
  keyLabel = DEFAULT_KEY_HEADER,
}: Readonly<{
  readonly totals: readonly MarketingTotal[];
  /**
   * What the figures beside the bars are called. Branded, so this list names its
   * measurement with the same words as the table and the exported file rather
   * than with a noun of its own.
   */
  readonly countLabel: SummedFigureLabel;
  /** What the thing each bar stands for is called, on screen and in the table. */
  readonly keyLabel?: string;
}>): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const [largestTotal] = totals;
  if (largestTotal === undefined) {
    return <p className="text-muted-foreground text-sm">Nothing was counted in this range.</p>;
  }
  const largest = largestTotal.visitors;
  const counted = countedAcross(totals);
  const shown = expanded ? totals : totals.slice(0, COLLAPSED_ROWS);

  // Every entry, not the rows the collapse shows: the table is the whole of
  // what the bars draw, and one that stopped where the drawing stops would
  // leave a reader who cannot see the drawing with less than it carries.
  const caption = `${keyLabel} by ${countLabel}`;
  const dataTable = (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-muted-foreground text-xs uppercase">
          <th scope="col" className="py-1 pr-2 font-semibold">
            {keyLabel}
          </th>
          <th scope="col" className="py-1 pl-2 text-right font-semibold">
            {countLabel}
          </th>
          <th scope="col" className="py-1 pl-2 text-right font-semibold">
            {SHARE_HEADER}
          </th>
        </tr>
      </thead>
      <tbody>
        {totals.map((total) => (
          <tr key={total.key} className="border-border border-b">
            <th scope="row" className="py-1 pr-2 font-mono text-xs font-normal">
              {total.key}
            </th>
            <td className="py-1 pl-2 text-right tabular-nums">
              {formatVisitorCount(total.visitors, total.overflow)}
            </td>
            <td className="py-1 pl-2 text-right tabular-nums">
              {shareOfCounted(total.visitors, counted.visitors)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <figure className="m-0">
      {/* Both figure columns are named rather than only the count. The single
          right-aligned label sat above the rightmost column, which is the share,
          so it read as a claim that a percentage was a visitor count. Named in
          one line rather than one label per column: a separate label per column
          would have to align with tracks the rows size to their own content,
          which is how a column word ends up over the wrong figure. */}
      <p className="text-muted-foreground mb-1 px-1 text-right text-xs uppercase">
        {countLabel} <span aria-hidden="true">&middot;</span> {SHARE_HEADER}
      </p>
      <ul className="list-none p-0">
        {shown.map((total) => (
          <RankedRow
            key={total.key}
            fillPercent={largest === 0 ? 0 : (total.visitors / largest) * 100}
            accessibleName={rowName(
              total,
              countLabel,
              shareOfCounted(total.visitors, counted.visitors)
            )}
            className="grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,auto)]"
          >
            <span className="relative truncate font-mono text-xs">{total.key}</span>
            <span className="relative truncate text-right tabular-nums">
              {formatVisitorCount(total.visitors, total.overflow)}
            </span>
            <span className="relative truncate text-right text-xs tabular-nums">
              {shareOfCounted(total.visitors, counted.visitors)}
            </span>
          </RankedRow>
        ))}
      </ul>
      {totals.length > COLLAPSED_ROWS && !expanded && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show all {totals.length}
        </button>
      )}
      <DataDisclosure label={caption} table={dataTable} />
      <figcaption className="text-muted-foreground mt-2 text-xs">
        {rankingInsight(totals, largestTotal)}
      </figcaption>
    </figure>
  );
}
