/**
 * The estimated bytes one media generation's output rests in — the single
 * expression of the byte rule, beside the byte rate that prices it
 * (`mediaStorageNanoUsd` in
 * `packages/shared/src/affordability/estimate/storage-rate.ts`).
 *
 * It has one home because the storage leg is charged from it on three paths that
 * must agree to the nano: the server's admission ceiling, the client's cost
 * estimate, and the per-unit affordability verdict that greys a picker row. A
 * verdict priced without this leg is not a rounding difference — an image's
 * stored bytes cost more than a cheap image's generation does — so a second
 * expression of the rule presents rows as affordable that admission then
 * refuses (`docs/CODE-RULES.md` §One Implementation, Shared).
 *
 * The estimate is structural and tier-independent: bytes per REFERENCE UNIT (one
 * image, one second) times the units generated. Nothing here reads a model, a
 * provider or a clock, so the same inputs give the same bytes on every path.
 */

import {
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
} from '../constants.ts';
import type { Modality } from '../model/modality.ts';

/**
 * The modalities whose output rests in object storage. Derived from the closed
 * modality set rather than listed: a new stored modality then fails to compile
 * against the byte table below instead of silently estimating zero bytes.
 */
export type StoredMediaModality = Exclude<Modality, 'text' | 'embedding'>;

const BYTES_PER_UNIT: Readonly<Record<StoredMediaModality, number>> = {
  image: ESTIMATED_IMAGE_BYTES,
  video: ESTIMATED_VIDEO_BYTES_PER_SECOND,
  audio: ESTIMATED_AUDIO_BYTES_PER_SECOND,
};

/**
 * The bytes a generation of `units` reference units is estimated to store.
 *
 * `units` is a count — one image, or a second count — never a duration in
 * another unit. A non-integer or negative count refuses rather than producing a
 * fractional byte estimate that would only fail later inside `BigInt`.
 */
export function mediaOutputBytes(modality: StoredMediaModality, units: number): number {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new RangeError('media output units must be a non-negative integer');
  }
  return units * BYTES_PER_UNIT[modality];
}
