import { isRunnableModelShape } from '@hushbox/shared';
import {
  exceedsTrialBudget,
  isPremiumModel,
  premiumPriceThresholdNanoUsd,
  priceableModelFrom,
} from '@hushbox/shared/affordability';
import { trialTurnCostNanoUsd } from '@hushbox/shared/affordability/price/trial';
import { tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import { validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { ModelDescriptor, NanoUSD } from '@hushbox/shared';
import type { PriceableModel } from '@hushbox/shared/affordability';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * The trial send gate: three pre-run refusals that keep the free trial to
 * cheap text models — the premium gate, per-model affordability against the 1¢
 * cap, and non-text blocking — all computed in integer nano-USD.
 *
 * Every classification rule is the money layer's: the price percentile, the
 * recency window and the minimal-exchange affordability leg are
 * `premiumPriceThresholdNanoUsd`, `isPremiumModel` and `exceedsTrialBudget`, and
 * both affordability legs price through the money layer's one trial turn price.
 * This file contributes what counts as a TEXT model, and nothing about premium.
 *
 * Cost basis, stated once (see also the chat slice's `trialGateVerdict`): the
 * 1¢ cap compares BILLABLE
 * cost — the same figure a paid send would be charged, never the worst-case run
 * ceiling. Both legs are PROVIDER-ONLY, because a trial turn never persists
 * (§Trial Usage). They differ only in their input basis, deliberately: the
 * MODEL-level leg prices a fixed synthetic exchange, because "may this model ever
 * be used on trial" must not move with what a user typed, while the per-send leg
 * prices the send's own character count.
 */

// Re-exported, not re-derived: the money layer owns the cap, and this slice's
// barrel is where the gates that compose it read it from. The cap compares
// BILLABLE (all-in) cost against this.
export { TRIAL_MESSAGE_COST_CAP_NANO_USD } from '@hushbox/shared/affordability';

/**
 * The coarse prompt-character basis the MODEL-level classification leg prices
 * its minimal exchange over. A fixed figure, not the turn's real prompt: this
 * leg answers "may this model ever be used on trial", which must not move with
 * what a user typed. At 3 characters per token it is 334 input tokens, and the
 * 2,000 output tokens dominate it.
 */
const TRIAL_CLASSIFICATION_PROMPT_CHARS = 1000;

type TrialEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'non-text' | 'premium' };

/**
 * A model is text for trial purposes iff it accepts text input and its one
 * output is text. The input leg and the single-output leg are
 * `isRunnableModelShape`'s — a multi-output model, text-plus-media included, is
 * refused there rather than by the clause below, and the exposed catalog holds
 * none to refuse: `isExposedModel` gates on that same predicate. What the clause
 * adds is the shapes that predicate admits whose one output is not text (image
 * or video output today, and any routable output kind added later).
 *
 * What the clause is worth on a trial send depends on which endpoint sourced the
 * target, and the two answers are opposite. A MEDIA-SOURCED descriptor — priced
 * per unit by the image or video path, carrying no per-token rate and no context
 * length — fails the `priceableModelFrom` guard in
 * {@link trialEligibilityAgainst} anyway, so for it the clause only buys a
 * `MEDIA_TRIAL_BLOCKED` refusal in place of `PREMIUM_REQUIRES_ACCOUNT`. A
 * LANGUAGE-sourced row whose one output is an image carries both rate legs and a
 * context length (the derivation is in {@link priceableTextPool}), so it
 * projects priceable and — priced modestly and old enough for the recency leg —
 * clears the premium and affordability checks alike: for that target this clause
 * is the whole refusal.
 */
export function isTextModel(descriptor: ModelDescriptor): boolean {
  return isRunnableModelShape(descriptor) && descriptor.outputs[0] === 'text';
}

/**
 * The priceable text pool the premium percentile is taken over: text models the
 * money layer can project. Being projectable IS membership in §Predicates'
 * priceable catalog pool, so a model missing a per-token rate or a context length
 * is out of the distribution — and, as a target, refused at the gate rather than
 * left to error mid-send.
 *
 * The text filter is not redundant with projectability, and this is a money
 * path, so the reason is worth stating. Catalog normalization refuses a
 * LANGUAGE-sourced row over its output modality in two separate places: the
 * language path refuses outputs matching no call-shape family, and group
 * resolution refuses the merged content over `isRunnableModelShape`, which is
 * what kills multi-output and embedding-output rows. Token pricing and the
 * context-length limit are applied to whatever those two admit, image and video
 * outputs included. So a text→image row carries per-token rates and a context
 * length, passes the exposure gate, and projects as priceable — and
 * {@link isTextModel} is the only thing keeping it out of the percentile this
 * pool feeds, which is the premium threshold both the trial gate and the
 * catalog's premium classification are decided against. The colocated test's
 * premium-price-boundary block pins it.
 */
function priceableTextPool(exposedCatalog: readonly ModelDescriptor[]): readonly PriceableModel[] {
  return exposedCatalog
    .filter((descriptor) => isTextModel(descriptor))
    .flatMap((descriptor) => {
      const model = priceableModelFrom(descriptor);
      return model === undefined ? [] : [model];
    });
}

/**
 * The premium price threshold one exposed catalog implies: the money layer's
 * percentile over that catalog's priceable text subset. A WHOLE-POOL
 * computation, and the reason it is exported rather than folded into the gate
 * below — a caller classifying every model in a catalog takes it once for the
 * catalog, never once per model.
 */
export function premiumThresholdFor(
  exposedCatalog: readonly ModelDescriptor[]
): NanoUSD | undefined {
  return premiumPriceThresholdNanoUsd(priceableTextPool(exposedCatalog));
}

/**
 * Whether a model may be used on the free trial, judged against an
 * ALREADY-COMPUTED price threshold. Blocks non-text models first, then premium
 * models. `nowMs` is the reference clock for recency.
 *
 * Both premium legs and the trial affordability leg are the money layer's own
 * (`isPremiumModel`, `premiumPriceThresholdNanoUsd`, `exceedsTrialBudget`): the
 * percentile and the recency window exist ONCE, inside the module, so this gate
 * and every other premium surface cannot drift apart.
 */
export function trialEligibilityAgainst(
  target: ModelDescriptor,
  priceThresholdNanoUsd: NanoUSD | undefined,
  nowMs: number
): TrialEligibility {
  if (!isTextModel(target)) return { eligible: false, reason: 'non-text' };
  const model = priceableModelFrom(target);
  // Un-priceable (no plain per-token rate, or no context length) is refused at
  // the gate as premium — sending it would error mid-pricing.
  if (model === undefined) return { eligible: false, reason: 'premium' };

  // The release date rides the projection, which is also where the catalog's
  // seconds become the milliseconds every comparison in the money module uses.
  const premium = isPremiumModel({
    model,
    ...(priceThresholdNanoUsd === undefined ? {} : { priceThresholdNanoUsd }),
    nowMs,
  });

  if (premium || exceedsTrialBudget(model, TRIAL_CLASSIFICATION_PROMPT_CHARS)) {
    return { eligible: false, reason: 'premium' };
  }
  return { eligible: true };
}

/**
 * The single source for whether a model may be used on the free trial, for a
 * caller judging ONE model. `exposedCatalog` is the full exposed catalog (from
 * `listDescriptors`); the percentile is taken over its priceable text subset.
 */
export function trialEligibility(
  target: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): TrialEligibility {
  return trialEligibilityAgainst(target, premiumThresholdFor(exposedCatalog), nowMs);
}

/**
 * The BILLABLE cost of the ACTUAL trial message on a minimum basis: the money
 * layer's one trial turn price over the input the model will see, NOT the
 * worst-case run ceiling. The trial gate refuses the send when this exceeds
 * `TRIAL_MESSAGE_COST_CAP_NANO_USD` — a long resent history legitimately trips
 * the cap, which is the honest cost of the send.
 *
 * **Provider cost only, and the basis is the WHOLE prompt.** Those are one change
 * and neither is correct without the other:
 *
 * - No storage. §Trial Usage's "trial never persists" is unconditional, so a turn
 *   that stores nothing must not be priced for storage.
 * - `promptChars` is what the SEND will carry — system prompt, custom
 *   instructions, history and the new input — counted by the one shared counter,
 *   never history-plus-prompt alone. Storage used to mask the difference: the
 *   system prompt's unpriced input tokens sat under the storage term, so
 *   removing storage without widening the basis would let a turn the compiled
 *   definition prices above 1¢ through this gate whenever input costs more per
 *   token than output. With the whole prompt priced, this gate's surplus over that
 *   floor is 1,000 output tokens at the model's own output rate — positive for
 *   every rate shape, inverted ones included.
 *
 * A target without a token price refuses: it has no trial turn to price.
 */
export function trialMessageBillableNanoUsd(
  target: ModelDescriptor,
  promptChars: number
): Result<bigint, DomainError> {
  if (!Number.isSafeInteger(promptChars) || promptChars < 0) {
    return err(validationError('trial message promptChars must be a non-negative integer'));
  }
  const pricing = tokenPricingOf(target.pricing);
  if (pricing === undefined) {
    return err(validationError('model pricing is not a token price'));
  }
  return ok(trialTurnCostNanoUsd(pricing, promptChars));
}
