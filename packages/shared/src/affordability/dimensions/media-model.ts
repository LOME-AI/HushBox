/**
 * `MediaModel` — the narrow projection a per-unit-priced model presents to the
 * dimension registry, the sibling of `PriceableModel` (`docs/BILLING.md`
 * §Data Structures). A media row prices per image or per second, not per token,
 * so it carries its per-unit price and the model's own catalog parameter domains
 * instead of a context length and a token schedule.
 *
 * The two projections PARTITION the catalog rather than overlapping, and that is
 * the property everything else rests on. `priceableModelFrom` fails closed
 * without a token price and a context length; a pure image/video descriptor has
 * neither, so no media row can enter the priceable pool — which is what keeps
 * the three money verdicts taken over that pool (the outlier median, the
 * premium price threshold and the classifier engine) exactly where they were
 * before media became a dimension. This constructor is the other half: it
 * refuses anything the language call shape already prices, including a merged
 * text+image row.
 *
 * No cost math lives here. A media dimension's requirement prices on the price
 * core's media curve, the curve the server's admission estimate and the
 * client's media estimate price on too.
 */

import { PRICING_KIND_BY_FAMILY, callShapeFamilyFor } from '../model/model-descriptor.ts';
import { modelId } from '../model/model-id.ts';
import { mediaPricingOf } from '../price/wire.ts';
import type { ModelId } from '../model/model-id.ts';
import type { ModelDescriptor } from '../model/model-descriptor.ts';
import type { ParamSpec as ParameterSpec } from '../model/param-spec.ts';
import type { MediaPricing, ModelPricing } from '../price/schedule.ts';

export interface MediaModel {
  readonly modelId: ModelId;
  /** The parsed per-unit price: its anchor and the dearest unit a hold reserves. */
  readonly pricing: MediaPricing;
  /**
   * The model's own catalog parameter domains. Media option sets are PER MODEL —
   * one video model offers 4 and 8 second durations where another offers 5 — so a
   * media dimension reads its domain from here rather than declaring a global
   * one, which is what stops a second hand-maintained option domain existing.
   */
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
}

/**
 * The four fields the projection reads, as the served catalog row carries them
 * once `wire-media-row.ts` has parsed its price. It is the per-unit counterpart
 * of `PoolCandidateRow`.
 */
interface MediaCandidateRow {
  readonly id: string;
  readonly outputs: readonly ModelDescriptor['outputs'][number][];
  readonly pricing: ModelPricing;
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
}

/**
 * The projection, or `undefined` when the row is not per-unit priceable.
 * Two gates, both fail-closed: the call shape must be a PURE media one (a
 * text-emitting row routes through the language shape and is already in the
 * priceable pool), and the row's price must be the kind that shape bills by —
 * a price in another unit refuses rather than pricing a generation it cannot.
 */
export function mediaModelFrom(row: MediaCandidateRow): MediaModel | undefined {
  const family = callShapeFamilyFor(row.outputs);
  if (family !== 'image' && family !== 'video') return undefined;
  const pricing = mediaPricingOf(row.pricing);
  if (pricing?.kind !== PRICING_KIND_BY_FAMILY[family]) return undefined;
  return { modelId: modelId(row.id), pricing, parameters: row.parameters };
}
