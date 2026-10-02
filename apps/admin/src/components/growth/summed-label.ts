/**
 * The one vocabulary this dashboard names a per-bucket distinct count with,
 * whether a surface adds those buckets together or shows one bucket at a time.
 *
 * Every figure that adds them is a lower bound rather than a total. One reason
 * holds wherever buckets are added: a visitor who returned in a later bucket is
 * counted in each of them. A second holds only where a bucket's value is the
 * largest of the rows in it rather than their sum, which is why the captions
 * below differ rather than reading as one sentence — a figure that simply adds
 * its buckets loses nothing that way, and a caption telling its reader otherwise
 * describes an operation that figure never performed. The system never inflates
 * a number, so the bias is deliberate, and the reader has to be able to see it,
 * which is what these labels are for.
 *
 * It lives in one place because two honest labels phrased differently read as
 * two different claims: a column saying "daily uniques, summed" beside a bar
 * saying "counted per bucket" invites the reader to think the two figures were
 * built differently when they were not.
 */

import type { GrowthGrain } from '@hushbox/shared';

declare const summedLabelBrand: unique symbol;

/**
 * A figure's name with its bucketing stated, obtainable only from
 * {@link summedCountLabel}.
 *
 * The brand is what a surface cannot spell for itself: a chart taking one of
 * these cannot be handed a hand-written noun that leaves the bucketing off,
 * which is how a further name for a figure other surfaces had already named
 * reached the page.
 */
export type SummedFigureLabel = string & { readonly [summedLabelBrand]: 'SummedFigureLabel' };

/** How a summed figure's buckets were cut. */
export type SummedBucketing = 'daily' | 'hourly';

/**
 * The bucketing a read's grain produces. One mapping, because a figure whose
 * label named a different bucketing from the one it was counted over would be
 * a wrong label rather than a differently worded one.
 */
export function bucketingOfGrain(grain: GrowthGrain): SummedBucketing {
  return grain === 'day' ? 'daily' : 'hourly';
}

/** The parenthetical that names the buckets a distinct count was taken over. */
export function uniquesQualifier(bucketing: SummedBucketing): string {
  return `${bucketing} uniques`;
}

/** The parenthetical that marks a figure as a summed per-bucket count. */
export function summedQualifier(bucketing: SummedBucketing): string {
  return `${uniquesQualifier(bucketing)}, summed`;
}

/**
 * A figure's name where the count shown is one bucket's own cardinality:
 * `Visitors (daily uniques)`. A surface that adds buckets together takes
 * {@link summedCountLabel} instead.
 *
 * It shares its stem with the summed name so the two read as one vocabulary,
 * and it is deliberately unbranded: the two name different measurements, so
 * the compiler refuses this one wherever {@link SummedFigureLabel} is required.
 */
export function perBucketCountLabel(noun: string, bucketing: SummedBucketing): string {
  return `${noun} (${uniquesQualifier(bucketing)})`;
}

/** A figure's name with its bucketing stated: `Visitors (daily uniques, summed)`. */
export function summedCountLabel(noun: string, bucketing: SummedBucketing): SummedFigureLabel {
  return `${noun} (${summedQualifier(bucketing)})` as SummedFigureLabel;
}

/**
 * A chart datum's accessible name: what the datum is, what its figure is called,
 * and the figure. One composer for every chart that names a datum, because a map
 * region and a ranked bar phrasing the same measurement differently read as two
 * different measurements.
 *
 * The datum ends in a period rather than a hyphen or a bracket: a speech
 * synthesiser runs the datum straight into the figure's name under either of
 * those, and a listener has no visual grouping to recover the boundary from.
 */
export function chartDatumLabel(
  datum: string,
  countLabel: SummedFigureLabel,
  figure: string
): string {
  return `${datum}. ${countLabel}: ${figure}`;
}

/**
 * The one name for the ceiling flag wherever a surface states it in words — an
 * exported column's header, a chart datum's accessible name. The trailing sign
 * `formatVisitorCount` prints, in
 * `apps/admin/src/components/growth/funnel-math.ts`, is the same fact drawn
 * rather than said, and a second wording of it would read as a second fact.
 */
export const CEILING_REACHED = 'Ceiling reached';

/** Why adding buckets together undercounts, wherever buckets are added. */
const REPEAT_COUNTING = 'someone counted in two buckets counts in each';

/**
 * The sentence a caption carries beside a figure whose buckets are simply added
 * together — nothing inside a bucket is discarded.
 */
export const LOWER_BOUND_NOTE = `Summed per-bucket counts are a lower bound: ${REPEAT_COUNTING}.`;

/**
 * The sentence a caption carries beside a figure whose bucket value is the
 * largest of the rows in that bucket rather than their sum.
 *
 * It says what the maximum ranges over rather than which steps take one: a
 * bucket holds a row per page, and per event name too on a step that admits
 * more than one name — so two admitted names fired on the same page in one
 * bucket keep only the larger. Stated as what a bucket holds, because the list
 * of admitted names is designed to grow and a sentence naming the members would
 * be falsified by the next one.
 */
export const LARGEST_ROW_LOWER_BOUND_NOTE = `Summed per-bucket counts are a lower bound: ${REPEAT_COUNTING}, and a bucket holding several rows keeps the largest of them rather than their sum (a row per page, and a row per event name as well on a step that admits more than one).`;
