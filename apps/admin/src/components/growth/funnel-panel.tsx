import * as React from 'react';
import { ANONYMOUS_STEP_NOTE } from '@hushbox/shared';
import { formatNanoUsd } from '@/lib/nano-usd';
import { DataDisclosure } from './data-disclosure.js';
import { formatRate } from './format-rate.js';
import { biggestDropOf, buildFunnelLadder, formatVisitorCount, stepLabel } from './funnel-math.js';
import { CEILING_REACHED, LARGEST_ROW_LOWER_BOUND_NOTE, summedQualifier } from './summed-label.js';
import type { BiggestDrop, FunnelStep } from './funnel-math.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/**
 * The sign a rate carries where a ceiling cut one of the counts it divides.
 *
 * Deliberately not the `+` a capped count carries. A ceiling bounds a count
 * from one side only, so `+` reads as "at least this" and is honest on a
 * count; a rate has no such side, because a cut numerator understates it and a
 * cut denominator overstates it. A rate wearing the count's sign would claim a
 * lower bound it does not have, which is the reason the two signs differ.
 */
const CAPPED_RATE_MARKER = '*';

/** What the sign means, wherever a surface says it rather than draws it. */
const CAPPED_RATE_NOTE = 'a ceiling cut an input to this rate, so it may be high or low';

/**
 * The panel's one explanation of the sign.
 *
 * It says what reaching the ceiling suggests as well as what it does to the
 * figure: the ceiling is an abuse bound rather than a storage budget, and the
 * bound on identities one address may mint in a day is a hundredth of it, so a
 * bucket that reaches it is likelier to be an attacked stretch than a popular
 * one. A reader who cannot suspect that reads a capped week as a good week.
 */
const CAPPED_RATE_LEGEND = `Rates marked ${CAPPED_RATE_MARKER} had an input cut by a ceiling, so they may be high or low; a bucket reaches that ceiling under abuse sooner than under popularity.`;

/**
 * What a capped rate leaves open about the step the caption names. Which pair
 * of steps wins the comparison is settled by the rates themselves, so a rate
 * the ceiling can move either way can move the winner with it.
 */
const CAPPED_DROP_NOTE = 'A rate whose input hit a ceiling may have chosen this step.';

/** A rate as the panel draws it: the figure, and the sign where one is owed. */
function drawnRate(rate: number | null, capped: boolean): string {
  return `${formatRate(rate)}${capped ? CAPPED_RATE_MARKER : ''}`;
}

/**
 * The qualifier a spoken rate carries, placed after whatever names the figure.
 * The surfaces that are read rather than seen get the sign's meaning in words,
 * because a sign read aloud is either the name of a piece of punctuation or
 * nothing at all.
 */
function spokenQualifier(capped: boolean): string {
  return capped ? ` (${CAPPED_RATE_NOTE})` : '';
}

/** A rate as the panel says it where the figure stands on its own. */
function spokenRate(rate: number | null, capped: boolean): string {
  return `${formatRate(rate)}${spokenQualifier(capped)}`;
}

/**
 * The caption's opening sentence: which pair of steps the most people fell out
 * between, and whether a capped rate is why that pair is the one named.
 */
function dropSentence(drop: BiggestDrop | null): string {
  if (drop === null) return 'No step-to-step drop could be measured for this week.';
  const named = `Biggest drop: ${drop.from} → ${drop.to} (${drawnRate(drop.rate, drop.rateCapped)}).`;
  return drop.comparisonCapped ? `${named} ${CAPPED_DROP_NOTE}` : named;
}

/**
 * Everything the bar conveys, in words. The bar is drawn with colour, a fill
 * pattern and a printed number, and this sentence is the fourth encoding — the
 * one a reader who sees none of the drawing gets.
 */
function barLabel(step: FunnelStep): string {
  const parts = [`${stepLabel(step)}: ${formatVisitorCount(step.count, step.overflow)}`];
  if (step.bucketing !== null) {
    parts.push(`a lower bound: ${summedQualifier(step.bucketing)}`);
  }
  if (step.overflow === true) {
    parts.push(CEILING_REACHED);
  }
  if (step.stepRate !== null) {
    parts.push(
      `${formatRate(step.stepRate)} of the step above${spokenQualifier(step.stepRateCapped)}`
    );
  }
  if (step.cumulativeRate !== null) {
    parts.push(
      `${formatRate(step.cumulativeRate)} of the top${spokenQualifier(step.cumulativeRateCapped)}`
    );
  }
  return parts.join('. ');
}

/**
 * What each column of a row holds, from one definition the bars, the heading
 * over them and the table beneath all read. Two spellings of one column would
 * read as two different figures across the three surfaces.
 */
const COLUMNS = {
  step: 'Step',
  count: 'Count',
  stepRate: 'Step rate',
  cumulativeRate: 'Cumulative rate',
} as const;

/**
 * The row shape the heading and every bar share, so a figure always sits under
 * the word naming it.
 *
 * Every track of the wide shape but the bar's may shrink to nothing. A `1fr`
 * track carries an implicit `auto` minimum, so a bare `1fr` is not a
 * shrinkable track at all: its longest word sets a floor the row cannot go
 * below, which is what pushes a row past its panel.
 *
 * The narrow shape has one column, so every cell of a row — the step name, the
 * bar and each of the three figures — takes a line of its own, and each figure
 * carries the word naming it rather than sitting under a heading. Three figures
 * abreast is what that replaces: at 375px with text at 141 percent the row is
 * 211px, no split of which holds a five-digit count beside `No rate` and
 * `100.0%`, and the count is right-aligned, so what a too-wide one does is not
 * widen the panel but draw itself over the rate beside it. A figure drawn over
 * a figure destroys both, and live counts reach that width by the screen
 * counting more visitors, with nothing to warn of it. The vertical room three
 * lines cost at phone width is the cheaper loss.
 *
 * The bar's track carries the one floor on the row, and it is there because a
 * grid maximizes its length-bounded tracks before it expands a flexible one: at
 * a large text size the three figure columns took the whole row and the bar was
 * drawn 0px wide, which is the chart disappearing rather than shrinking.
 *
 * The step column's ceiling is what is left over from the bar: the bar is the
 * comparison the panel exists to draw, and the ceiling is set at the widest
 * value that costs no step its line count, so the room goes to the bar rather
 * than to whitespace after the shortest labels. Its text wraps rather than
 * truncating, because the tail of its label is the qualifier that makes a
 * summed figure a lower bound rather than a total.
 */
const ROW_TRACKS =
  'grid-cols-1 sm:grid-cols-[minmax(0,14rem)_minmax(2rem,1fr)_minmax(0,3.5rem)_minmax(0,4rem)_minmax(0,4rem)] items-center gap-x-2 text-sm';

/** The shape of a bar's row, which the heading reads its own tracks from. */
const ROW_GRID = `grid ${ROW_TRACKS}`;

/**
 * The shape of the words over the bars, drawn only where there are columns for
 * them to head. In the narrow shape the figures stack, so a heading row would
 * put three words over one figure.
 */
const HEADING_ROW = `hidden sm:grid ${ROW_TRACKS}`;

/** What an account-identified step's bar is filled with: the ramp at full strength. */
const IDENTIFIED_FILL = 'bg-seq-5';

/**
 * What an anonymous step's bar is filled with. A hatch of two ramp steps rather
 * than a hue of its own: the fill has to say "this count is a lower bound" to a
 * reader who tells no two colours apart, and a pattern says it where a colour
 * cannot.
 */
const ANONYMOUS_FILL =
  'bg-[repeating-linear-gradient(135deg,var(--seq-4)_0_5px,var(--seq-3)_5px_10px)]';

/**
 * What the biggest drop is marked with. Brand red as an outline and a tint
 * rather than as ink: the brand red stands 3.56:1 off this card, which a
 * graphical mark clears and text of this size does not.
 */
const DROP_MARK = 'border-brand-red bg-brand-red-subtle rounded-sm border px-1 font-semibold';

/**
 * How wide a bar is drawn, as a percentage of the row.
 *
 * A step nobody reached draws nothing. The floor below it keeps a step that did
 * count somebody from disappearing, and drawing that same sliver for a count of
 * none would picture a quantity the figure beside it denies.
 */
function drawnWidth(step: FunnelStep): string {
  if (step.count === 0) return '0%';
  return `${String(Math.max(step.widthRatio * 100, 1))}%`;
}

/**
 * One figure of a row: under the heading's word in the wide shape, beside its
 * own copy of that word in the narrow one, where there is no heading. Both
 * spellings come from {@link COLUMNS}, so the word a figure is read by is the
 * same word in either shape.
 */
function FigureCell({
  label,
  className,
  children,
}: Readonly<{
  label: string;
  className?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <span
      className={`flex items-baseline justify-between gap-2 tabular-nums sm:block sm:text-right ${className ?? ''}`}
    >
      <span className="text-muted-foreground text-xs uppercase sm:hidden">{label}</span>
      <span data-slot="funnel-figure">{children}</span>
    </span>
  );
}

function FunnelBar({
  step,
  isBiggestDrop,
}: Readonly<{ step: FunnelStep; isBiggestDrop: boolean }>): React.JSX.Element {
  return (
    <li
      // A chart's bars are data, not controls, and the accessible pattern for one
      // is a tab stop per bar carrying the figure as its name — the approach the
      // WAI charting guidance and Highcharts' accessibility module both take.
      // Without it a keyboard reader cannot walk the chart at all.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- data tab stop, per the comment above
      tabIndex={0}
      aria-label={barLabel(step)}
      className={`focus-visible:ring-ring ${ROW_GRID} rounded py-0.5 focus-visible:ring-2 focus-visible:outline-hidden`}
    >
      <span>{stepLabel(step)}</span>
      <span className="bg-muted relative block h-5 rounded">
        <span
          data-slot="funnel-bar-fill"
          // Width is the only per-bar value a class cannot carry; every colour
          // and the pattern itself come from tokens through the classes below.
          style={{ width: drawnWidth(step) }}
          className={`block h-5 rounded ${step.anonymous ? ANONYMOUS_FILL : IDENTIFIED_FILL}`}
        />
        {step.count === 0 && (
          // A step nobody reached draws a mark of its own rather than nothing at
          // all: an empty track is what a step still loading looks like, and the
          // reading here is that the step was counted and counted nobody.
          <span
            data-slot="funnel-bar-zero"
            aria-hidden="true"
            className="bg-border-strong absolute inset-y-0.5 left-0 w-0.5"
          />
        )}
      </span>
      <FigureCell label={COLUMNS.count}>{formatVisitorCount(step.count, step.overflow)}</FigureCell>
      <FigureCell label={COLUMNS.stepRate} className="text-xs">
        {isBiggestDrop ? (
          <span data-slot="funnel-biggest-drop" className={DROP_MARK}>
            {drawnRate(step.stepRate, step.stepRateCapped)}
          </span>
        ) : (
          drawnRate(step.stepRate, step.stepRateCapped)
        )}
      </FigureCell>
      <FigureCell label={COLUMNS.cumulativeRate} className="text-xs">
        {drawnRate(step.cumulativeRate, step.cumulativeRateCapped)}
      </FigureCell>
    </li>
  );
}

/**
 * What each way of drawing a bar means, in view and without a press. The bars
 * carry three encodings a reader has to be told the meaning of, and the fourth
 * item keys the one mark the panel puts in brand red.
 */
function LadderLegend(): React.JSX.Element {
  return (
    <ul
      data-slot="funnel-legend"
      className="text-muted-foreground mt-2 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs"
    >
      <li className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className={`h-2.5 w-5 shrink-0 rounded-sm ${IDENTIFIED_FILL}`} />
        <span>Account-identified step</span>
      </li>
      <li className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className={`h-2.5 w-5 shrink-0 rounded-sm ${ANONYMOUS_FILL}`} />
        <span>Anonymous step, a lower bound</span>
      </li>
      <li className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className="bg-border-strong h-2.5 w-0.5 shrink-0" />
        <span>Counted zero, not a small bar</span>
      </li>
      <li className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className={`${DROP_MARK} h-2.5 w-5 shrink-0`} />
        <span>Biggest drop</span>
      </li>
    </ul>
  );
}

/** The words over the bars, so the two rates beside each are told apart by name. */
function LadderHeading(): React.JSX.Element {
  return (
    <p
      data-slot="funnel-heading"
      aria-hidden="true"
      className={`text-muted-foreground ${HEADING_ROW} mb-1 text-xs uppercase`}
    >
      <span>{COLUMNS.step}</span>
      <span />
      <span className="text-right">{COLUMNS.count}</span>
      <span className="text-right">{COLUMNS.stepRate}</span>
      <span className="text-right">{COLUMNS.cumulativeRate}</span>
    </p>
  );
}

/**
 * One campaign's ladder for one week, as stepped bars. Stepped rather than a
 * trapezoid funnel: a trapezoid encodes the count in an area whose width and
 * height both vary, which distorts the comparison the panel exists to support.
 */
export function FunnelPanel({ week }: Readonly<{ week: GrowthFunnelWeekWire }>): React.JSX.Element {
  const ladder = buildFunnelLadder(week);
  const drop = biggestDropOf(ladder);
  const anyRateCapped = ladder.some((step) => step.stepRateCapped || step.cumulativeRateCapped);
  const caption = `Registration ladder for ${week.campaign}`;

  return (
    <figure className="m-0">
      <p className="text-muted-foreground mb-2 text-xs font-semibold uppercase">
        Campaign: {week.campaign}
      </p>
      <LadderHeading />
      <ul data-slot="funnel-ladder" className="list-none p-0">
        {ladder.map((step) => (
          <FunnelBar key={step.label} step={step} isBiggestDrop={drop?.to === step.label} />
        ))}
      </ul>
      <LadderLegend />
      <DataDisclosure
        label={caption}
        table={
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="text-muted-foreground text-xs uppercase">
                <th scope="col" className="py-1 pr-2 font-semibold">
                  {COLUMNS.step}
                </th>
                {/* A row's own name carries its bucketing where it has one, and
                    the steps do not share one, so the column is headed by what
                    they have in common rather than by a noun true of only some. */}
                <th scope="col" className="py-1 pl-2 text-right font-semibold">
                  {COLUMNS.count}
                </th>
                <th scope="col" className="py-1 pl-2 text-right font-semibold">
                  {COLUMNS.stepRate}
                </th>
                <th scope="col" className="py-1 pl-2 text-right font-semibold">
                  {COLUMNS.cumulativeRate}
                </th>
              </tr>
            </thead>
            <tbody>
              {ladder.map((step) => (
                <tr key={step.label} className="border-border border-b">
                  <th scope="row" className="py-1 pr-2 font-normal">
                    {stepLabel(step)}
                  </th>
                  <td className="py-1 pl-2 text-right tabular-nums">
                    {formatVisitorCount(step.count, step.overflow)}
                  </td>
                  <td className="py-1 pl-2 text-right">
                    {spokenRate(step.stepRate, step.stepRateCapped)}
                  </td>
                  <td className="py-1 pl-2 text-right">
                    {spokenRate(step.cumulativeRate, step.cumulativeRateCapped)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      />
      <figcaption className="text-muted-foreground mt-2 text-xs">
        {dropSentence(drop)} {anyRateCapped ? `${CAPPED_RATE_LEGEND} ` : ''}
        {ANONYMOUS_STEP_NOTE} {LARGEST_ROW_LOWER_BOUND_NOTE} Revenue this cohort:{' '}
        {formatNanoUsd(week.revenueNanoUsd)}.
      </figcaption>
    </figure>
  );
}
