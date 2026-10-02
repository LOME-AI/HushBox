import * as React from 'react';
import { ScrollRegion } from '@hushbox/ui';
import { COHORT_STEP_CLASSES, choroplethStep, cohortShadeClass } from './choropleth-scale.js';
import { formatRate } from './format-rate.js';
import {
  formatVisitorCount,
  identifiedLadderColumns,
  ladderCsvColumns,
  ladderStepTotal,
  overflowAcross,
} from './funnel-math.js';
import { dayOf } from './growth-window.js';
import type { CsvColumn } from './csv.js';
import type { LadderColumn } from './funnel-math.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/**
 * The identified steps only, named as the ladder names them rather than by a
 * second list here. The anonymous steps above them are bucketed by the week
 * their own events happened rather than by a cohort's creation week, so putting
 * them in a cohort row would label them with a week they do not belong to.
 */
const COLUMNS = identifiedLadderColumns();

/** What the creation-week column is called, on screen and in the exported file. */
const COHORT_HEADER = 'Cohort';

/**
 * What this grid says it is, to a reader of the table and to a keyboard reader
 * landing on the box it scrolls inside. One sentence rather than two, so the
 * tab stop and the caption cannot come to say different things.
 */
const TABLE_CAPTION = 'Accounts by creation week and how far each cohort went';

/**
 * What a cell with no share to take is drawn as. A dashed outline rather than a
 * step of the ramp: the palest step stands 1.07:1 off the card it is drawn on,
 * so a cohort that counted nobody shaded at the bottom of the scale would be
 * indistinguishable from one whose share simply rounded low.
 */
const NO_SHARE_CELL = 'border-border border border-dashed text-muted-foreground';

/** What the cells that do carry a share are drawn in. */
const SHARE_CELL = 'text-seq-foreground';

/** One cohort: the creation week, and the ladder rows grouped under it. */
export interface Cohort {
  readonly week: string;
  readonly rows: readonly GrowthFunnelWeekWire[];
}

/** The ladder rows grouped by creation week, oldest first. */
export function cohorts(weeks: readonly GrowthFunnelWeekWire[]): readonly Cohort[] {
  const byWeek = new Map<string, GrowthFunnelWeekWire[]>();
  for (const row of weeks) {
    byWeek.set(row.week, [...(byWeek.get(row.week) ?? []), row]);
  }
  return [...byWeek.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([week, rows]) => ({ week, rows }));
}

/**
 * This grid as a file: counts under the step names the grid displays, with a
 * ceiling column beside a step only where that step's table records a flag.
 *
 * Counts alone, as the ladder's own export writes counts and leaves its rates
 * on screen — a share of a count that may be a floor is uncertain in a
 * direction nothing here can state.
 */
export function cohortColumns(): readonly CsvColumn<Cohort>[] {
  return [
    { header: COHORT_HEADER, value: (cohort) => cohort.week },
    ...COLUMNS.flatMap((column) => ladderCsvColumns<Cohort>(column, (cohort) => cohort.rows)),
  ];
}

/**
 * Accounts by creation week and how far each cohort went.
 *
 * Every campaign's row for a week is added together, which is exact here: an
 * account carries one campaign, so no account is counted twice. The shading is
 * a second encoding of the share already printed in the cell.
 */
export function CohortGrid({
  weeks,
}: Readonly<{ weeks: readonly GrowthFunnelWeekWire[] }>): React.JSX.Element {
  const rowsByWeek = cohorts(weeks);

  if (rowsByWeek.length === 0) {
    return <p className="text-muted-foreground text-sm">No cohorts were created in this range.</p>;
  }

  return (
    <div>
      <ScrollRegion label={TABLE_CAPTION} className="overflow-x-auto rounded-sm">
        <table className="w-full border-separate border-spacing-0.5 text-left text-sm">
          <caption className="sr-only">{TABLE_CAPTION}</caption>
          <thead>
            <tr className="text-muted-foreground text-xs uppercase">
              <th scope="col" className="py-1 pr-2 font-semibold">
                {COHORT_HEADER}
              </th>
              {COLUMNS.map((column) => (
                <th key={column.label} scope="col" className="py-1 pl-2 text-right font-semibold">
                  {/* Held to its longest word, so a heading's one-line width
                      asks the table for no room its cells would then give up
                      by wrapping a share under its count. */}
                  <span className="inline-block w-min">{column.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsByWeek.map((cohort) => {
              const [createdColumn, ...laterColumns] = COLUMNS;
              const created = ladderStepTotal(cohort.rows, createdColumn);
              // Each cell asks its own column for a ceiling flag rather than
              // assuming none: the columns here all count accounts and keep no
              // flag today, and a cell that hard-coded that would state it as a
              // fact about any column added later.
              const cellOf = (
                column: LadderColumn
              ): { label: string; total: number; figure: string } => {
                const total = ladderStepTotal(cohort.rows, column);
                return {
                  label: column.label,
                  total,
                  figure: formatVisitorCount(
                    total,
                    overflowAcross(cohort.rows, column.readOverflow)
                  ),
                };
              };
              const cells = [
                cellOf(createdColumn),
                ...laterColumns.map((column) => cellOf(column)),
              ];
              return (
                <tr key={cohort.week}>
                  <th
                    scope="row"
                    className="py-1 pr-2 font-mono text-xs font-normal whitespace-nowrap"
                  >
                    {dayOf(new Date(cohort.week))}
                  </th>
                  {cells.map((cell) => {
                    const share = created === 0 ? null : cell.total / created;
                    const shade =
                      share === null
                        ? NO_SHARE_CELL
                        : `${SHARE_CELL} ${cohortShadeClass(choroplethStep(share * 100, 100))}`;
                    return (
                      <td
                        key={cell.label}
                        className={`rounded-sm px-1.5 py-1 text-right tabular-nums ${shade}`}
                      >
                        {cell.figure}
                        {/* The break keeps a column's minimum at the wider of count
                            and share rather than their sum, so a longer count wraps
                            its share instead of widening the table past its box. */}
                        <wbr />
                        {/* Size, not colour, is what sets the share apart from the
                            count: both ride the ramp's own partner ink, which is
                            what clears the floor at the deep steps, and a second
                            colour printed on the shade would not. */}
                        <span className="ml-1 text-xs whitespace-nowrap">
                          {/* Heard, not seen: with nothing between the two figures a
                              screen reader joins them into one number the cell never
                              printed. */}
                          <span className="sr-only">, </span>
                          {formatRate(share)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      <CohortLegend />
    </div>
  );
}

/**
 * What the shading means and what the outlined cells mean, in view and without a
 * press: the shade is a second encoding of a figure the cell already prints, and
 * the outline is the one case the ramp cannot carry.
 */
function CohortLegend(): React.JSX.Element {
  return (
    <ul
      data-slot="cohort-legend"
      className="text-muted-foreground mt-2 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs"
    >
      <li className="flex flex-wrap items-center gap-1.5">
        <span>Share of the cohort</span>
        {/* The strip is one fixed width the steps divide, rather than five cells
            of a fixed width each: five widths that each grow with the text size
            outgrew the panel at the largest tier. */}
        <span aria-hidden="true" className="flex h-2.5 w-20 shrink-0">
          {COHORT_STEP_CLASSES.map((step) => (
            <span key={step} className={`flex-1 first:rounded-l-sm last:rounded-r-sm ${step}`} />
          ))}
        </span>
        <span className="tabular-nums">0% to 100%</span>
      </li>
      <li className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden="true"
          className="border-border h-2.5 w-5 shrink-0 rounded-sm border border-dashed"
        />
        <span>No share to take: the cohort counted nobody, rather than a share of none</span>
      </li>
    </ul>
  );
}
