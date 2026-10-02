/**
 * What a pending media turn will cost: the customer-facing total for one
 * generation across every selected model — the billable provider cost, carrying
 * the fee once because catalog rates already do, plus pass-through output
 * storage.
 *
 * It is the whole reservation, not a component: admission holds a media call at
 * its generation on the price core's media curve plus its stored output, so
 * this is the same number admission holds for the same inputs. A surface names
 * the turn — this modality, these models, this duration — and never the curve
 * or the rates behind it (`docs/BILLING.md` §Where the Code Lives).
 *
 * Image and video are exact: every input fixes the cost, and each selected
 * model is reserved at its dearest unit, the side the server's hold reserves.
 * Audio is not a priced modality: no price kind represents it, so no audio row
 * projects onto a per-unit model and an audio turn refuses. Fail-closed: an
 * unpriceable turn refuses, so a caller cannot mistake "not priceable yet" for
 * "free".
 */

import { mediaUnitsCostNanoUsd } from '../dimensions/media.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { mediaModelFromWire } from '../model/wire-media-row.ts';
import { mediaOutputBytes } from './output-bytes.ts';
import { mediaStorageNanoUsd } from './storage-rate.ts';
import { estimateErr, estimateOk } from './types.ts';
import type { EstimateResult } from './types.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { Model } from '../../schemas/api/models.ts';

/**
 * One media turn's priceable inputs: the served rows of the selected models.
 * The duration and the resolution ride only on the modalities priced per
 * second, so an image turn cannot carry one: the reference quantity of an image
 * turn is the image, and it is the money layer's fact rather than a
 * caller-supplied 1.
 */
export type MediaTurnCostInput =
  | { readonly modality: 'image'; readonly models: readonly Model[] }
  | {
      readonly modality: 'video';
      readonly models: readonly Model[];
      /** The resolution every selected model generates at, which keys its per-second rate. */
      readonly resolution: string;
      /** Seconds generated, fixed at request time. */
      readonly durationSeconds: number;
    }
  | {
      readonly modality: 'audio';
      readonly models: readonly Model[];
      readonly durationSeconds: number;
    };

/** The reference-unit count one turn generates: one image, or N seconds. */
function unitsOf(input: MediaTurnCostInput): number {
  return input.modality === 'image' ? 1 : input.durationSeconds;
}

export function mediaTurnCostNanoUsd(input: MediaTurnCostInput): EstimateResult<NanoUSD> {
  if (input.models.length === 0) {
    return estimateErr('invalid-request', 'at least one model is required');
  }
  const units = unitsOf(input);
  if (!Number.isSafeInteger(units) || units < 1) {
    return estimateErr('invalid-request', 'media units must be a positive integer');
  }
  const quantity =
    input.modality === 'video' ? { units, dimensionKey: input.resolution } : { units };
  let generation = 0n;
  for (const row of input.models) {
    const model = mediaModelFromWire(row);
    const cost = model === undefined ? undefined : mediaUnitsCostNanoUsd(model, quantity);
    if (cost === undefined) {
      return estimateErr(
        'model-pricing-incomplete',
        `model '${row.id}' states no price for this turn`
      );
    }
    generation += cost;
  }
  const storage =
    mediaStorageNanoUsd(mediaOutputBytes(input.modality, units)) * BigInt(input.models.length);
  return estimateOk(nanoUSD(generation + storage));
}
