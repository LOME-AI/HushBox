import { figureCeilingReachedColumn } from './csv.js';
import { summedCountLabel } from './summed-label.js';
import type { CsvColumn } from './csv.js';
import type { SummedBucketing } from './summed-label.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/**
 * The ladder columns are the numeric ones. Naming the type this way is what
 * lets the rungs below read a field without a runtime check for a string: the
 * week and campaign columns are simply not nameable.
 */
type NumericWeekField = {
  [K in keyof GrowthFunnelWeekWire]: GrowthFunnelWeekWire[K] extends number ? K : never;
}[keyof GrowthFunnelWeekWire];

/**
 * Where a step's ceiling flag is read off a week.
 *
 * A step has one only where the table behind it records one, which is why every
 * holder of one is nullable: a step without a reader states nothing about its
 * ceiling rather than stating that no ceiling was reached.
 */
export type OverflowReader = (week: GrowthFunnelWeekWire) => boolean;

/**
 * One bar of the ladder. `stepRate` and `cumulativeRate` are null rather than
 * zero when their denominator counted nobody: a rate out of nothing is not a
 * rate of nothing, and rendering it as 0% would assert a drop-off that was
 * never measured.
 */
export interface FunnelStep {
  readonly label: string;
  readonly count: number;
  /**
   * No account identity stands behind this step's count. The bars are
   * pattern-filled on this flag, and the caption states what the fill means.
   */
  readonly anonymous: boolean;
  /**
   * A bucket behind this figure hit its member ceiling, so the figure is a
   * floor. Null where the table behind the step records no ceiling flag: that
   * is the store holding no evidence either way, which is a different fact
   * from a ceiling that was not reached.
   */
  readonly overflow: boolean | null;
  /**
   * How this step's buckets were cut, when the figure is a sum of per-bucket
   * distinct counts — which makes it a lower bound the label has to state.
   * Null on a step that counts accounts, where no summing happens.
   */
  readonly bucketing: SummedBucketing | null;
  /** This step out of the step above it. */
  readonly stepRate: number | null;
  /**
   * A ceiling cut one of the counts {@link FunnelStep.stepRate} divides, so the
   * rate may be high or low. False where there is no rate, there being no
   * figure to qualify.
   */
  readonly stepRateCapped: boolean;
  /** This step out of the top of the ladder. */
  readonly cumulativeRate: number | null;
  /** The same reading of {@link FunnelStep.cumulativeRate}'s two counts. */
  readonly cumulativeRateCapped: boolean;
  /** Bar length against the widest step, so one long bar cannot overflow the row. */
  readonly widthRatio: number;
}

interface LadderRung {
  readonly label: string;
  readonly anonymous: boolean;
  readonly bucketing: SummedBucketing | null;
  readonly field: NumericWeekField;
  readonly readOverflow: OverflowReader | null;
}

/**
 * The steps counted from anonymous sets, top to bottom. Each is a sum of
 * per-bucket distinct counts, which is why each states its bucketing. What
 * makes a step anonymous, and how the bars draw it: `ANONYMOUS_STEP_NOTE` in
 * `packages/shared/src/growth/funnel-steps.ts`.
 *
 * The entry step is named for every destination that means entering the
 * product rather than for the signup page alone, which is the list the view
 * behind it filters on.
 */
const ANONYMOUS_RUNGS: readonly [LadderRung, ...LadderRung[]] = [
  {
    label: 'Visited',
    anonymous: true,
    bucketing: 'daily',
    field: 'visitorsDailySummed',
    readOverflow: (week) => week.visitorsOverflow,
  },
  {
    label: 'Clicked into the product',
    anonymous: true,
    bucketing: 'hourly',
    field: 'productEntryClicksHourlySummed',
    readOverflow: (week) => week.productEntryClicksOverflow,
  },
  // Registration starts are distinct caller identities per hour, summed over the
  // week — the same shape as the ladder's other per-bucket sums, so it carries
  // the same bucketing rather than reading as an exact count of people. Its set
  // is ceiling-bounded like theirs and its hour rows record the refusal, so the
  // step reads a flag on the same terms.
  {
    label: 'Started registration',
    anonymous: true,
    bucketing: 'hourly',
    field: 'started',
    readOverflow: (week) => week.startedOverflow,
  },
];

/**
 * The steps that count accounts, top to bottom. Non-empty because the first of
 * them is the cohort size every share in the cohort grid is taken against.
 */
const IDENTIFIED_RUNGS: readonly [LadderRung, ...LadderRung[]] = [
  {
    label: 'Account created',
    anonymous: false,
    bucketing: null,
    field: 'finished',
    readOverflow: null,
  },
  {
    label: 'Email verified',
    anonymous: false,
    bucketing: null,
    field: 'verified',
    readOverflow: null,
  },
  {
    label: 'Sent a message',
    anonymous: false,
    bucketing: null,
    field: 'activated',
    readOverflow: null,
  },
  {
    label: 'Returned week 1',
    anonymous: false,
    bucketing: null,
    field: 'returnedWeek1',
    readOverflow: null,
  },
  {
    label: 'First payment',
    anonymous: false,
    bucketing: null,
    field: 'firstPaid',
    readOverflow: null,
  },
];

/**
 * The ladder's rungs, top to bottom, with the field each one reads. Typed as a
 * non-empty tuple because the top rung is the denominator every cumulative rate
 * is taken against — there is no ladder without one.
 */
const LADDER: readonly [LadderRung, ...LadderRung[]] = [...ANONYMOUS_RUNGS, ...IDENTIFIED_RUNGS];

/**
 * A step's name as every surface names it: the step, with the bucketing stated
 * wherever the figure is a sum of per-bucket counts. One rule, so no two
 * surfaces can name one figure differently.
 */
function nameOf(step: {
  readonly label: string;
  readonly bucketing: SummedBucketing | null;
}): string {
  return step.bucketing === null ? step.label : summedCountLabel(step.label, step.bucketing);
}

/** The name a rendered step carries. */
export function stepLabel(step: FunnelStep): string {
  return nameOf(step);
}

/** One ladder step's name and the fields it reads, for a surface that lists them all. */
export interface LadderColumn {
  readonly label: string;
  readonly field: NumericWeekField;
  /** Where the step's own ceiling flag is read, or null where its table keeps none. */
  readonly readOverflow: OverflowReader | null;
}

function columnOf(rung: LadderRung): LadderColumn {
  return { label: nameOf(rung), field: rung.field, readOverflow: rung.readOverflow };
}

/**
 * The ceiling flag of the weeks a figure adds together: any flagged week makes
 * the total a floor. The same rule the database reduces a window's flags by,
 * applied where the page does the adding itself — one rule, so a figure summed
 * on the page and the same figure summed in a view cannot disagree about
 * whether it is a floor.
 *
 * Null where the step keeps no flag, which is the store holding no evidence
 * rather than evidence that no ceiling was reached.
 */
export function overflowAcross(
  weeks: readonly GrowthFunnelWeekWire[],
  readOverflow: OverflowReader | null
): boolean | null {
  return readOverflow === null ? null : weeks.some((week) => readOverflow(week));
}

/**
 * The ladder rows the page's campaign selection leaves. Selecting nothing is
 * the page's way of selecting every campaign, so it narrows nothing.
 *
 * One definition because the page scopes these rows for two different outputs —
 * which rows a file gets and which figures it gets columns for. Two spellings of
 * this predicate that drifted would put a week in a file under a figure that was
 * never computed over it, and the blank cells would look like measurements of
 * none.
 */
export function campaignScoped(
  weeks: readonly GrowthFunnelWeekWire[],
  selectedCampaigns: readonly string[]
): readonly GrowthFunnelWeekWire[] {
  return selectedCampaigns.length === 0
    ? weeks
    : weeks.filter((week) => selectedCampaigns.includes(week.campaign));
}

/**
 * Every step in ladder order, named as the bars name them. A surface listing the
 * steps reads this instead of writing its own names: a file whose columns are
 * called something other than the screen's is a second set of names for one set
 * of figures.
 */
export function ladderColumns(): readonly LadderColumn[] {
  return LADDER.map((rung) => columnOf(rung));
}

/**
 * The account-counting steps only, non-empty, for a surface that takes shares
 * against the first of them.
 */
export function identifiedLadderColumns(): readonly [LadderColumn, ...LadderColumn[]] {
  const [first, ...rest] = IDENTIFIED_RUNGS;
  return [columnOf(first), ...rest.map((rung) => columnOf(rung))];
}

/** A rate, or null when the denominator counted nobody. */
function rateOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** A count and the ceiling flag of the table it came from. */
interface CountedSide {
  readonly count: number;
  readonly overflow: boolean | null;
}

/**
 * A rate and whether a ceiling cut either count it divides.
 *
 * One flag rather than one per side because the two are not separable facts for
 * a reader: a ceiling bounds a count from below, so a cut numerator understates
 * the rate, a cut denominator overstates it, and both cut leaves the direction
 * unknown. What a surface can honestly say in every one of those cases is that
 * the figure may be wrong either way, which is one flag's worth of meaning.
 *
 * A rate nobody could compute carries no flag: marking a dash would qualify a
 * figure that was never stated.
 */
function ratePart(
  numerator: CountedSide,
  denominator: CountedSide
): { readonly rate: number | null; readonly capped: boolean } {
  const rate = rateOf(numerator.count, denominator.count);
  return {
    rate,
    capped: rate !== null && (numerator.overflow === true || denominator.overflow === true),
  };
}

/** The ladder for one week of one campaign. */
export function buildFunnelLadder(week: GrowthFunnelWeekWire): readonly FunnelStep[] {
  const [topRung, ...restRungs] = LADDER;
  const rungs: readonly [LadderRung & { count: number }, ...(LadderRung & { count: number })[]] = [
    { ...topRung, count: week[topRung.field] },
    ...restRungs.map((rung) => ({ ...rung, count: week[rung.field] })),
  ];
  const [head, ...rest] = rungs;
  const widest = Math.max(...rungs.map((rung) => rung.count));

  const top: CountedSide = {
    count: head.count,
    overflow: overflowAcross([week], head.readOverflow),
  };
  const steps: FunnelStep[] = [
    {
      label: head.label,
      count: head.count,
      anonymous: head.anonymous,
      bucketing: head.bucketing,
      overflow: top.overflow,
      stepRate: null,
      stepRateCapped: false,
      cumulativeRate: rateOf(head.count, head.count),
      // Its own count over itself, so it is 1 on whichever side of its ceiling
      // the count landed. Marking it would tell a reader a figure that cannot
      // be wrong may be wrong, which is the defect the marker exists to remove
      // rather than a second instance of it.
      cumulativeRateCapped: false,
      widthRatio: widest === 0 ? 0 : head.count / widest,
    },
  ];
  let above = top;
  for (const rung of rest) {
    const side: CountedSide = {
      count: rung.count,
      overflow: overflowAcross([week], rung.readOverflow),
    };
    const step = ratePart(side, above);
    const cumulative = ratePart(side, top);
    steps.push({
      label: rung.label,
      count: rung.count,
      anonymous: rung.anonymous,
      bucketing: rung.bucketing,
      overflow: side.overflow,
      stepRate: step.rate,
      stepRateCapped: step.capped,
      cumulativeRate: cumulative.rate,
      cumulativeRateCapped: cumulative.capped,
      widthRatio: widest === 0 ? 0 : rung.count / widest,
    });
    above = side;
  }
  return steps;
}

/** The pair of adjacent steps the most people fell out between. */
export interface BiggestDrop {
  readonly from: string;
  readonly to: string;
  readonly rate: number;
  /** A ceiling cut one of the counts {@link BiggestDrop.rate} divides. */
  readonly rateCapped: boolean;
  /**
   * A ceiling cut an input to one of the rates this comparison ranked, so the
   * pair named may not be the pair people fell out between hardest.
   *
   * Wider than {@link BiggestDrop.rateCapped} deliberately: a capped rate that
   * lost the comparison could have won it had its counts been whole, and that
   * leaves the winner in doubt while the winner's own counts are beyond
   * reproach.
   */
  readonly comparisonCapped: boolean;
}

/** The pair of adjacent steps the most people fell out between. */
export function biggestDropOf(ladder: readonly FunnelStep[]): BiggestDrop | null {
  let worst: { from: string; to: string; rate: number; rateCapped: boolean } | null = null;
  let comparisonCapped = false;
  for (const [index, step] of ladder.entries()) {
    const previous = ladder[index - 1];
    if (previous === undefined || step.stepRate === null) continue;
    comparisonCapped = comparisonCapped || step.stepRateCapped;
    if (worst === null || step.stepRate < worst.rate) {
      worst = {
        from: previous.label,
        to: step.label,
        rate: step.stepRate,
        rateCapped: step.stepRateCapped,
      };
    }
  }
  return worst === null ? null : { ...worst, comparisonCapped };
}

/**
 * A visitor count as the dashboard states it. An overflowed bucket hit its set
 * ceiling, so its figure is a floor rather than a total, and the trailing sign
 * is what stops a reader taking it for the whole.
 *
 * A null flag is a figure whose store keeps no ceiling evidence. It prints
 * plainly, exactly as an unflagged one does, because the alternative is a
 * surface asserting that no ceiling was reached on a question nothing answered.
 */
export function formatVisitorCount(value: number, overflow: boolean | null): string {
  const grouped = value.toLocaleString('en-US');
  return overflow === true ? `${grouped}+` : grouped;
}

/** One ladder step's count over a set of week rows. */
export function ladderStepTotal(
  weeks: readonly GrowthFunnelWeekWire[],
  column: LadderColumn
): number {
  return weeks.reduce((sum, week) => sum + week[column.field], 0);
}

/**
 * One ladder step's columns in an exported file: its count over whatever week
 * rows the exported row stands for, and its ceiling column beside it only where
 * the step's table records a flag.
 *
 * One rule rather than one per exporting surface. Which steps are marked is
 * the thing exported files must agree on: a step written with a ceiling column
 * in one file and without it in another would read as two different
 * measurements of the same step.
 */
export function ladderCsvColumns<T>(
  column: LadderColumn,
  weeksOf: (row: T) => readonly GrowthFunnelWeekWire[]
): readonly CsvColumn<T>[] {
  const count: CsvColumn<T> = {
    header: column.label,
    value: (row) => ladderStepTotal(weeksOf(row), column),
  };
  const readOverflow = column.readOverflow;
  return readOverflow === null
    ? [count]
    : [
        count,
        figureCeilingReachedColumn<T>(column.label, (row) =>
          overflowAcross(weeksOf(row), readOverflow)
        ),
      ];
}
