import { figureCeilingReachedColumn } from './csv.js';
import { campaignScoped, overflowAcross } from './funnel-math.js';
import { dayOf } from './growth-window.js';
import { summedCountLabel } from './summed-label.js';
import type { CsvAbsentColumn, CsvColumn } from './csv.js';
import type { OverflowReader } from './funnel-math.js';
import type { MarginalTotal } from './marketing-rows.js';
import type { SummedBucketing } from './summed-label.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/** The countable columns — the week and campaign labels are not among them. */
type NumericWeekField = {
  [K in keyof GrowthFunnelWeekWire]: GrowthFunnelWeekWire[K] extends number ? K : never;
}[keyof GrowthFunnelWeekWire];

/**
 * The campaign-free marginals the anonymous figures are read from when the
 * selection does not name a single campaign, each null where its read holds no
 * bucket for the week on screen.
 *
 * They are read rather than summed because each anonymous figure is a count of
 * distinct visitors: adding two campaigns' figures counts a visitor who saw
 * both of them twice, and every anonymous figure in this design is built to be
 * a lower bound, never an overstatement. The account figures need none of this —
 * an account carries exactly one campaign, so summing them counts each account
 * once.
 */
export interface UnscopedMarginals {
  readonly visitors: MarginalTotal | null;
  readonly productEntryClicks: MarginalTotal | null;
}

/**
 * Why an anonymous figure is withheld when the campaign-free read holds nothing
 * for the week on screen.
 *
 * A marginal carries a bucket for each hour or day it counted somebody in. No
 * bucket at all means the week was never measured, which is a different claim
 * from a count of nobody — and a tile drawing a nought for both would make the
 * two indistinguishable to the reader.
 */
export const NO_MARGINAL_ROW_REASON =
  'No whole-site row for this week, so there is no figure to state, not a count of none.';

/**
 * Why a figure is withheld when the ladder carries no row for what is selected.
 *
 * A ladder row is written for a week a campaign was running in. No row means
 * the question was never measured for that week and campaign, which is a
 * different claim from a row whose count is zero — and a tile drawing a nought
 * for both would make the two indistinguishable to the reader.
 */
export const NO_LADDER_ROW_REASON =
  'No ladder row for this week under the campaigns selected, so there is no figure to state, not a count of none.';

/** One point of a headline tile's sparkline. */
export interface HeadlinePoint {
  readonly week: string;
  readonly value: number;
  /** A week the figure's ceiling was reached in, or null where it keeps no flag. */
  readonly overflow: boolean | null;
}

/** What a headline tile carries whether or not the page had a figure for it. */
interface HeadlineFigureBase {
  /**
   * The figure's full name, bucketing included, as every surface that lists
   * these figures beside other figures names it: a column header, an exported
   * file's header, the sentence naming the figures a selection does not reach.
   */
  readonly label: string;
  /**
   * What the figure counts, without the bucketing. The tile draws this and puts
   * the bucketing in a chip beside it, so a reader scanning four tiles reads
   * four subjects rather than four parenthesised clauses; the two are carried
   * apart rather than cut out of {@link HeadlineFigureBase.label} at the tile,
   * because splitting a name by punctuation is a second naming rule.
   */
  readonly noun: string;
  /**
   * How the figure's buckets were cut, where its count is a sum of per-bucket
   * distinct counts. Null on a figure counted from accounts, which sums
   * nothing and so has no bucketing to state.
   */
  readonly bucketing: SummedBucketing | null;
  /**
   * The week the figure is counted for. Carried on the figure rather than
   * handed to each surface beside it, so nothing can draw a figure counted for
   * one week against the week before a different one.
   */
  readonly week: string;
  /**
   * A row this figure added had its count cut off by a set ceiling, so the
   * figure is a floor. Null on a figure counted from accounts, whose store
   * keeps no ceiling flag: an absent flag is no evidence, not evidence of no
   * ceiling.
   */
  readonly overflow: boolean | null;
}

/** A figure the page has a count for. */
type StatedFigure = HeadlineFigureBase & {
  readonly value: number;
  readonly unavailableReason: null;
  readonly spark: readonly HeadlinePoint[];
};

/** A figure the page has the reason it withheld it in place of a count. */
type WithheldFigure = HeadlineFigureBase & {
  readonly value: null;
  readonly unavailableReason: string;
  readonly spark: readonly [];
};

/**
 * One headline tile: its figure, or the reason there is none to state. The two
 * cases are a union rather than one shape with nullable fields, so a figure
 * cannot be built holding a count and a reason both, and {@link isStated}
 * narrows to the case its callers then read.
 */
export type HeadlineFigure = StatedFigure | WithheldFigure;

/**
 * The headline figures: the field each reads its count from off a ladder row,
 * where its ceiling flag is read or that its table keeps none, and which
 * campaign-free marginal answers for it where the selection names no single
 * campaign. The entry figure is named for every destination that means
 * entering the product, which is what the step behind it counts.
 *
 * A null reader marks a figure each account contributes to exactly once, which
 * is what makes adding the selected campaigns' rows sound for it.
 */
const FIGURES: readonly {
  readonly noun: string;
  readonly bucketing: SummedBucketing | null;
  readonly field: NumericWeekField;
  readonly readOverflow: OverflowReader | null;
  readonly readUnscoped: ((marginals: UnscopedMarginals) => MarginalTotal | null) | null;
}[] = [
  {
    noun: 'Visitors',
    bucketing: 'daily',
    field: 'visitorsDailySummed',
    readOverflow: (week) => week.visitorsOverflow,
    readUnscoped: (marginals) => marginals.visitors,
  },
  {
    noun: 'Product entry clicks',
    bucketing: 'hourly',
    field: 'productEntryClicksHourlySummed',
    readOverflow: (week) => week.productEntryClicksOverflow,
    readUnscoped: (marginals) => marginals.productEntryClicks,
  },
  {
    noun: 'Accounts created',
    bucketing: null,
    field: 'finished',
    readOverflow: null,
    readUnscoped: null,
  },
  {
    noun: 'First payments',
    bucketing: null,
    field: 'firstPaid',
    readOverflow: null,
    readUnscoped: null,
  },
];

/**
 * A figure's full name from its subject and its bucketing, by the one rule the
 * ladder's own steps are named under. One derivation, so a tile's chip and a
 * file's header cannot come to disagree about what the figure is called.
 */
function nameOf(figure: {
  readonly noun: string;
  readonly bucketing: SummedBucketing | null;
}): string {
  return figure.bucketing === null ? figure.noun : summedCountLabel(figure.noun, figure.bucketing);
}

/**
 * Whether the selection names the one campaign a per-campaign row can be read
 * for. One predicate, because the figures and what the page declares about them
 * are answers to the same question: a page whose declaration and whose figures
 * disagreed about which campaigns were reached is the confusion the declaration
 * exists to remove.
 */
function oneCampaign(selectedCampaigns: readonly string[]): boolean {
  return selectedCampaigns.length === 1;
}

/**
 * The leading figures a campaign selection does not reach, under the names
 * their tiles carry.
 *
 * None where it names a single campaign, which every figure follows; none again
 * where it names no campaign, because a selection that narrows nothing leaves
 * no figure outside it. Everything else is a selection that narrows the account
 * figures while the anonymous ones come from the campaign-free marginal — the
 * state a panel and a file have to declare, or their one sentence about scope
 * is false of those two.
 */
export function figuresOutsideSelection(selectedCampaigns: readonly string[]): readonly string[] {
  if (selectedCampaigns.length === 0 || oneCampaign(selectedCampaigns)) return [];
  return FIGURES.filter((figure) => figure.readUnscoped !== null).map((figure) => nameOf(figure));
}

function sumOver(rows: readonly GrowthFunnelWeekWire[], field: NumericWeekField): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

/** Every week these ladder rows carry, oldest first. */
function weeksCovered(rows: readonly GrowthFunnelWeekWire[]): readonly string[] {
  return [...new Set(rows.map((row) => row.week))].toSorted((left, right) =>
    left.localeCompare(right)
  );
}

/** A figure the page cannot state, and the reason it cannot. */
function withheld(
  figure: { readonly noun: string; readonly bucketing: SummedBucketing | null },
  week: string,
  reason: string
): WithheldFigure {
  return {
    label: nameOf(figure),
    noun: figure.noun,
    bucketing: figure.bucketing,
    week,
    value: null,
    unavailableReason: reason,
    overflow: null,
    spark: [],
  };
}

/** How far apart two weeks of the ladder are. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A week's count against the count of the week before it. */
export interface WeekOnWeekChange {
  /** The day the week before began, as the rest of the page spells a day. */
  readonly previousDay: string;
  /** This week's count less that week's. */
  readonly change: number;
}

/**
 * How a figure moved since the week before it, or null where no change can be
 * stated: the page withheld the figure, the week before holds no count of its
 * own, or a ceiling cut one of the two counts.
 *
 * The ceiling cases are refused rather than marked. A ceiling bounds a count
 * from one side, so the difference between two bounded counts is unbounded in
 * both directions — a stated change there would be a figure neither count
 * supports, which is a stronger claim than either of them makes.
 *
 * The week before is the week seven days earlier and not simply the previous
 * point the trend carries: a ladder holds no row for a week a campaign was not
 * running in, so the point before a gap belongs to an earlier week than the one
 * a reader takes "the week before" to mean.
 */
export function weekOnWeekChange(figure: HeadlineFigure): WeekOnWeekChange | null {
  if (!isStated(figure) || figure.overflow === true) return null;
  const previousWeek = new Date(Date.parse(figure.week) - WEEK_MS);
  const before = figure.spark.find((point) => Date.parse(point.week) === previousWeek.getTime());
  if (before === undefined || before.overflow === true) return null;
  return { previousDay: dayOf(previousWeek), change: figure.value - before.value };
}

/**
 * The figures at the top of the dashboard, for one week, under whichever
 * campaigns the page is scoped to — an empty selection meaning every campaign.
 *
 * The account figures follow that selection exactly: an account carries one
 * campaign, so adding the chosen campaigns' rows counts each account once. The
 * anonymous figures cannot be added that way, so unless the selection names a
 * single campaign they come from the campaign-free marginal instead of the
 * ladder — an exact count rather than a sum, which is why neither carries a
 * caveat.
 *
 * A marginal answers for the week on screen and for no other, so the figure it
 * states holds one point rather than a trend across the ladder's weeks.
 */
export function headlineFigures(
  weeks: readonly GrowthFunnelWeekWire[],
  selectedWeek: string,
  selectedCampaigns: readonly string[],
  marginals: UnscopedMarginals
): readonly HeadlineFigure[] {
  const inScope = campaignScoped(weeks, selectedCampaigns);
  const selected = inScope.filter((row) => row.week === selectedWeek);

  return FIGURES.map((figure) => {
    const named = { label: nameOf(figure), noun: figure.noun, bucketing: figure.bucketing };
    if (!oneCampaign(selectedCampaigns) && figure.readUnscoped !== null) {
      const marginal = figure.readUnscoped(marginals);
      if (marginal === null) return withheld(figure, selectedWeek, NO_MARGINAL_ROW_REASON);
      return {
        ...named,
        week: selectedWeek,
        value: marginal.count,
        unavailableReason: null,
        overflow: marginal.overflow,
        spark: [{ week: selectedWeek, value: marginal.count, overflow: marginal.overflow }],
      };
    }
    if (selected.length === 0) {
      return withheld(figure, selectedWeek, NO_LADDER_ROW_REASON);
    }
    return {
      ...named,
      week: selectedWeek,
      value: sumOver(selected, figure.field),
      unavailableReason: null,
      overflow: overflowAcross(selected, figure.readOverflow),
      // Reached only with a row in `selected`, which `inScope` holds too, so this
      // maps over at least one week — an argument rather than a check: a non-empty
      // tuple is rejected at this `.map`, which cannot supply its required first
      // element.
      spark: weeksCovered(inScope).map((week) => {
        const ofWeek = inScope.filter((row) => row.week === week);
        return {
          week,
          value: sumOver(ofWeek, figure.field),
          overflow: overflowAcross(ofWeek, figure.readOverflow),
        };
      }),
    };
  });
}

/** Every week any figure carries a point for, oldest first. */
export function headlineWeeks(figures: readonly HeadlineFigure[]): readonly string[] {
  const weeks = new Set(figures.flatMap((figure) => figure.spark.map((point) => point.week)));
  return [...weeks].toSorted((left, right) => left.localeCompare(right));
}

/**
 * The weeks a file of these figures has a row for: every week its ladder rows
 * carry, and every week a figure it states holds a point in.
 *
 * The ladder alone would leave a figure read from a campaign-free marginal with
 * a column whose every field is empty, because that figure's one week is the
 * week on screen and the ladder need not carry a row for it. The ladder half is
 * what keeps a file with every figure withheld from having no rows at all,
 * which would read as a read that returned nothing.
 */
export function headlineFileWeeks(
  rows: readonly GrowthFunnelWeekWire[],
  figures: readonly HeadlineFigure[]
): readonly string[] {
  const weeks = new Set([...weeksCovered(rows), ...headlineWeeks(figures)]);
  return [...weeks].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Whether the page had a figure to state, as against a reason it had none.
 *
 * One definition because every surface showing these figures asks it. A second
 * spelling that drifted would state a figure on one surface while another
 * reported it missing.
 */
export function isStated(figure: HeadlineFigure): figure is StatedFigure {
  return figure.unavailableReason === null;
}

/** The complement, for a caller whose branch is the withheld one. */
export function isWithheld(figure: HeadlineFigure): figure is WithheldFigure {
  return !isStated(figure);
}

/**
 * The columns a file of these figures carries, each read off a week: every
 * figure the page can state, under the name its tile carries, with its ceiling
 * column beside it where its points carry a reading.
 *
 * A figure the page withheld has no column at all — the file would otherwise
 * hold a column of blanks under a name nothing measured. What the file says
 * about that figure instead is {@link headlineAbsentColumns}, and both read the
 * one predicate, so a figure can neither earn a column and be reported missing
 * nor fall out of the file unmentioned. The weeks the file has rows for are a
 * separate question, answered by the rows the caller hands the export.
 */
export function headlineColumns(figures: readonly HeadlineFigure[]): readonly CsvColumn<string>[] {
  return [
    { header: 'Week', value: (week) => week },
    ...figures
      .filter((figure) => isStated(figure))
      .flatMap((figure) => {
        const pointAt = (week: string): HeadlinePoint | undefined =>
          figure.spark.find((point) => point.week === week);
        const count: CsvColumn<string> = {
          header: figure.label,
          value: (week) => pointAt(week)?.value ?? null,
        };
        return figure.spark.some((point) => point.overflow !== null)
          ? [
              count,
              figureCeilingReachedColumn<string>(
                figure.label,
                (week) => pointAt(week)?.overflow ?? null
              ),
            ]
          : [count];
      }),
  ];
}

/**
 * The columns a file of these figures has not got: one per figure the page
 * withheld, under the tile's own name for it and carrying the tile's own
 * reason.
 *
 * A tile shows its reason where its figure would be, and before this the file
 * showed nothing at all — so a file written with no campaign selected, which is
 * how the page opens, read as a headline covering only the figures it happened
 * to list. The file is the copy that outlives the screen, and a reader with no
 * screen beside it cannot tell a figure that was withheld from one that does
 * not exist.
 */
export function headlineAbsentColumns(
  figures: readonly HeadlineFigure[]
): readonly CsvAbsentColumn[] {
  return figures
    .filter((figure) => isWithheld(figure))
    .map((figure) => ({ header: figure.label, reason: figure.unavailableReason }));
}
