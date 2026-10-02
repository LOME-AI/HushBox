import type { MediaDimensionId, OptionId } from './dimensions/types.ts';
import type { MediaDimensionAvailability } from './turn/media-core.ts';
import type { Availability } from './turn/turn-types.ts';

/**
 * One option's verdict, read off the media set the per-unit producer returned.
 * The single place a surface may ask what the money layer said about one
 * option, so a picker and the send gate cannot answer it differently.
 *
 * A produced set carries every option any selected model OFFERS on that axis,
 * so an option it does not grade is an option nothing offers — refused, with
 * the reason that says so, rather than defaulted to available. A surface
 * rendering options from the catalog rather than from this set will ask about
 * some of them; that is exactly the case this answers CLOSED.
 *
 * NO SET AT ALL IS PERMISSIVE, DELIBERATELY. There is no verdict yet — a
 * funding or catalog read in flight, or one that failed — and the SEND GATE
 * owns that state: it refuses nothing while the read is pending, and refuses a
 * failed read through a separate signal this set cannot carry. Greying every
 * option here would make the picker stricter than the gate that actually blocks
 * the send, which is two surfaces of one producer disagreeing. Distinguishing a
 * pending read from an exhausted one at this seam would need a refusal this
 * type cannot express: {@link Availability} carries a `RefusalCode`, and the
 * failed-read reason is a `NoticeReason`.
 */
export function dimensionOptionAvailability(
  dimensions: readonly MediaDimensionAvailability[] | undefined,
  dimensionId: MediaDimensionId,
  optionId: OptionId
): Availability {
  if (dimensions === undefined) return { available: true };
  const dimension = dimensions.find((entry) => entry.dimensionId === dimensionId);
  const option = dimension?.options.find((entry) => entry.optionId === optionId);
  return option?.availability ?? { available: false, reason: 'option_not_offered' };
}
