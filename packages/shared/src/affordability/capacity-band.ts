/**
 * How full a context window is: the one comparison against the capacity
 * thresholds, and the one comparison against the window itself, for every
 * surface that reads either.
 *
 * The composer's meter and the pre-send near-capacity notice are the two
 * surfaces, and they used to compare separately: the meter banded on the
 * ROUNDED percent it displays while the notice compared the raw one, so a fill
 * in the fraction just below the red line painted red with no notice raised.
 * The band is answered here, on the unrounded percent, so the two cannot part
 * company again; rounding survives only in the meter's own numeric label, which
 * is display precision and no comparison at all.
 */

import { CAPACITY_RED_THRESHOLD, CAPACITY_YELLOW_THRESHOLD } from './constants.ts';

/** How full the context window is, in bands. Colour and copy are presentation. */
export type ContextFillBand = 'room_to_spare' | 'filling_up' | 'nearly_full';

/**
 * The band a fill is in, from the percent of the model's context it occupies
 * (the quantity `textTurnBudget` publishes; over 100 is a legal reading and
 * stays in the top band).
 *
 * `capacity-band` in `@hushbox/shared` is this comparison's only home: re-inlined
 * at a caller it is indistinguishable from code that was always local, so no
 * checker can tell the copy from an original and the split this module's header
 * describes returns unseen.
 */
export function contextFillBand(capacityPercent: number): ContextFillBand {
  if (capacityPercent >= CAPACITY_RED_THRESHOLD * 100) return 'nearly_full';
  if (capacityPercent >= CAPACITY_YELLOW_THRESHOLD * 100) return 'filling_up';
  return 'room_to_spare';
}

/**
 * Whether the prompt no longer fits the window at all — the boundary that
 * BLOCKS the send, distinct from the bands above, which only colour it.
 *
 * The composer's send gate and the pre-send `prompt_too_long` notice are the
 * two surfaces, in two packages. While each compared for itself, a drift
 * between them was a send refused with no notice saying why: the gate answers
 * whether the user may send, the notice is the only thing that tells them what
 * to shorten, and one answer without the other is a dead end. Compared on the
 * unrounded percent for the reason the bands are.
 *
 * `capacity-band` in `@hushbox/shared` is this comparison's only home: re-inlined
 * at a caller it is indistinguishable from code that was always local, so no
 * checker can tell the copy from an original and the drift above returns unseen.
 */
export function isOverContextCapacity(capacityPercent: number): boolean {
  return capacityPercent > 100;
}
