/**
 * `PriceableModel` — the narrow projection the money layer consumes instead of
 * the catalog descriptor (`docs/BILLING.md` §Data Structures). It is
 * load-bearing: because pricing, feasibility and the dimension registry read
 * this shape rather than a catalog row, a new catalog field or a new modality
 * cannot reshape money inputs, and every money function is testable against
 * hand-built fixtures with no catalog knowledge.
 *
 * A display name, a popularity rank and a ZDR flag are deliberately NOT here:
 * none of them is a money input, which is what keeps this shape from drifting
 * back into a descriptor copy. The release timestamp IS here, because premium
 * classification is a money verdict this module owns (§Model Classification) and
 * it grades on recency — so a row cannot be classified without it. The clock it
 * is compared against stays an argument (see `premium.ts`), so no release date
 * gives this module a clock.
 */

import { SECOND_MS } from '../../utils/durations.ts';
import { validCap } from '../estimate/reasoning-plan.ts';
import { tokenPricingOf } from '../price/wire.ts';
import { modelId } from './model-id.ts';
import type { ModelId } from './model-id.ts';
import type { ModelReasoning, ModelDescriptor } from './model-descriptor.ts';
import type { ReasoningPlanModel } from '../estimate/reasoning-plan.ts';
import type { ModelPricing, TokenPricing } from '../price/schedule.ts';

export interface PriceableModel {
  readonly modelId: ModelId;
  /** The model's parsed token schedule: billable (fee-inclusive) nano-USD rates. */
  readonly pricing: TokenPricing;
  readonly contextLength: number;
  /** Catalog max output tokens; absent ⇒ the context length alone bounds. */
  readonly providerCap: number | undefined;
  readonly reasoning: ModelReasoning | undefined;
  /**
   * Release timestamp in milliseconds. Required, not optional: the catalog
   * excludes a model whose release date is unknown, so a priceable model always
   * has one, and an optional field would invite a recency verdict on a model
   * with no release date.
   */
  readonly releasedAtMs: number;
}

/**
 * The money-input fields of a catalog row, whatever shape carries them. Named
 * apart from any one catalog type so the projection below can be reached from a
 * server descriptor and from a served wire row without either of them acquiring
 * its own copy of the rate, cap and release-date rules.
 */
interface PriceableRow {
  readonly id: string;
  readonly pricing: ModelPricing;
  readonly contextLength: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly reasoning: ModelReasoning | undefined;
  /** The catalog's release date in MILLISECONDS. */
  readonly releasedAtMs: number;
}

/**
 * The money projection of a row: rates, caps and release date. Not published —
 * {@link priceableModelFrom} and the pool projection are the two entry points,
 * and both reduce here so neither can drift on what a usable rate or cap is.
 */
export function projectPriceable(row: PriceableRow): PriceableModel | undefined {
  const pricing = tokenPricingOf(row.pricing);
  if (pricing === undefined) return undefined;
  const contextLength = validCap(row.contextLength);
  if (contextLength === undefined) return undefined;
  return {
    modelId: modelId(row.id),
    pricing,
    contextLength,
    providerCap: validCap(row.maxOutputTokens),
    reasoning: row.reasoning,
    releasedAtMs: row.releasedAtMs,
  };
}

/**
 * The projection, or `undefined` when the descriptor is not priceable — a
 * price that is not a token schedule, or a missing context length, fails closed
 * rather than becoming a zero rate, because a zero rate prices a turn as free.
 * Being priceable is exactly membership in §Predicates' priceable catalog pool.
 */
export function priceableModelFrom(descriptor: ModelDescriptor): PriceableModel | undefined {
  return projectPriceable({
    id: descriptor.id,
    pricing: descriptor.pricing,
    contextLength: descriptor.limits['contextLength'],
    maxOutputTokens: descriptor.limits['maxOutputTokens'],
    reasoning: descriptor.reasoning,
    releasedAtMs: releasedAtMsOf(descriptor.releasedAt),
  });
}

/**
 * The catalog dates a model in seconds; every comparison in this module is in
 * milliseconds, and this is the one place the two units meet — for a server
 * descriptor and for a served wire row alike.
 */
export function releasedAtMsOf(releasedAtSeconds: number): number {
  return releasedAtSeconds * SECOND_MS;
}

/**
 * The reasoning-plan input for a projected model. The plan's own field is named
 * `maxOutputTokens` (the catalog word) while the projection calls the same
 * quantity `providerCap` (the specification word); this is the one place the two
 * names meet, so no caller has to know they are the same number.
 */
export function reasoningPlanModelOf(model: PriceableModel): ReasoningPlanModel {
  return {
    reasoning: model.reasoning,
    contextLength: model.contextLength,
    maxOutputTokens: model.providerCap,
  };
}
