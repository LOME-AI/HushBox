/**
 * The served catalog row's adaptation onto {@link mediaModelFrom}, written ONCE
 * — the per-unit sibling of `poolModelFromWire`, and here for the same reason.
 *
 * The two adaptations differ in one thing beyond their rates. A media row's
 * option domains are PER MODEL, and the wire flattens them into three parallel
 * arrays, so a projection has to put them back into the `parameters` record the
 * dimension registry reads. Minting those specs is what the client used to do
 * for itself, which put the axis-to-catalog-key mapping in two places; it is
 * done here now, through the one media-spec minter, so a renamed axis is a
 * compile error rather than an axis that silently offers nothing.
 *
 * Rates cross the wire as decimal strings and become a price through the one
 * wire adapter, which parses them: a row whose rates the schedule cannot
 * represent — an absent rate for its own modality among them — has no price
 * rather than a free one, and no projection.
 */

import { mediaModelFrom } from '../dimensions/media-model.ts';
import { mediaParameterSpecs } from '../dimensions/media-params.ts';
import { pricingFromWire } from '../price/wire.ts';
import type { MediaModel } from '../dimensions/media-model.ts';
import type { Model } from '../../schemas/api/models.ts';
import type { ParamSpec as ParameterSpec } from './param-spec.ts';

/** The model's own media option domains, rebuilt from the wire's flat arrays. */
function parametersFromWire(model: Model): Readonly<Record<string, ParameterSpec>> {
  return mediaParameterSpecs({
    ...(model.supportedAspectRatios === undefined
      ? {}
      : { aspectRatio: model.supportedAspectRatios }),
    ...(model.supportedVideoResolutions === undefined
      ? {}
      : { resolution: model.supportedVideoResolutions }),
    ...(model.supportedVideoDurationsSeconds === undefined
      ? {}
      : { durationSeconds: model.supportedVideoDurationsSeconds }),
  });
}

/** The per-unit model behind a served catalog row, or `undefined` when it is not one. */
export function mediaModelFromWire(model: Model): MediaModel | undefined {
  const pricing = pricingFromWire(model);
  if (pricing === undefined) return undefined;
  return mediaModelFrom({
    id: model.id,
    // The wire carries the OUTPUT modality for real; the call-shape gate in the
    // projection is what refuses a text row, so no modality test is taken here.
    outputs: [model.modality],
    pricing,
    parameters: parametersFromWire(model),
  });
}
