/**
 * The one implementation of "this digit run may be grouped", shared by the text
 * gate and the binary gate.
 *
 * The separator used to be read as evidence a run was not an instant, on the
 * grounds that a grouped literal is hand-written and never machine-emitted —
 * but a hand-written instant is a disclosure exactly like a machine-emitted
 * one, and grouping broke the contiguous run both gates' patterns needed before
 * either era window or the day-boundary carve-out was consulted.
 *
 * Both detectors read the same vocabulary here rather than each spelling it:
 * two spellings of what counts as grouping are two detection policies, free to
 * drift into a hole in one gate that the other's tests cannot see.
 */

/** The JavaScript numeric separator, where a grouped literal may carry one. */
export const NUMERIC_SEPARATOR_SOURCE = String.raw`_?`;

/** A digit the separator may be grouped in front of. */
export const SEPARATED_DIGIT_SOURCE = String.raw`${NUMERIC_SEPARATOR_SOURCE}\d`;

/**
 * The number a matched run denotes, with its grouping separators removed.
 * Load-bearing rather than cosmetic: `Number` reads a separator as a parse
 * failure, and the resulting NaN fails every day-boundary predicate — so a
 * classifier reading the run raw would report every grouped instant, the
 * exempt day boundaries included.
 */
export function ungroupedValue(matched: string): number {
  return Number(matched.replaceAll('_', ''));
}
