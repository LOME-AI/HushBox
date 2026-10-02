/**
 * Premium model classification — one of the named structural seams of the money
 * layer (`docs/BILLING.md` §Where the Code Lives, §Model Classification).
 *
 * It lives inside the module because it compares a rate against a threshold,
 * and rate arithmetic is confined to the module. Outside it, the function had
 * to receive raw catalog rate strings and `parseFloat` them — float arithmetic
 * deciding a paid-access boundary. Taking a {@link PriceableModel}, whose rates
 * are exact nano-USD bigints, removes the reason that parse existed: the
 * comparison is now integer end to end.
 *
 * The price leg compares BILLABLE (fee-inclusive) rates against a BILLABLE
 * threshold. That is safe and requires no fee handling here, because the
 * threshold is a percentile of the same pool: scaling every rate by the same
 * factor moves the rates and the threshold together, so the classification is
 * unchanged. Fees are applied at their two seams only, never here.
 */

import { TRIAL_MESSAGE_COST_CAP_NANO_USD } from '../constants.ts';
import { nanoUSD } from './nano-usd.ts';
import { nanoPercentile } from '../percentile.ts';
import { combinedAnchorRateNanoUsd } from '../price/display.ts';
import { trialTurnCostNanoUsd } from '../price/trial.ts';
import type { NanoUSD } from './nano-usd.ts';
import type { PriceableModel } from '../model/priceable-model.ts';

export { TRIAL_AFFORDABILITY_MULTIPLIER } from '../price/trial.ts';

/** Combined prompt+completion rate at/above this quantile of the pool is premium. */
export const PREMIUM_PRICE_PERCENTILE = 0.75;

/** A model released within this window (~6 months) is premium on recency alone. */
export const PREMIUM_RECENCY_MS = 182 * 24 * 60 * 60 * 1000;

/**
 * A percentile is only meaningful over a real sample. Below this many priceable
 * models there is no threshold at all, so the price leg does not fire — a
 * one-model pool would otherwise mark its own model premium against itself.
 * Recency still decides.
 */
export const MIN_POOL_FOR_PRICE_PERCENTILE = 4;

/**
 * The combined billable rate at/above which a model is premium: the
 * {@link PREMIUM_PRICE_PERCENTILE} of the pool's own combined rates. `undefined`
 * when the pool is too small to have one ({@link MIN_POOL_FOR_PRICE_PERCENTILE}).
 *
 * The pool is a property of the catalog, never of a payer or a prompt, so the
 * classification is reproducible from the catalog alone and no row order can
 * change it. This is the ONE premium threshold: a caller holding a pool resolves
 * it here rather than ranking rates itself.
 */
export function premiumPriceThresholdNanoUsd(pool: readonly PriceableModel[]): NanoUSD | undefined {
  if (pool.length < MIN_POOL_FOR_PRICE_PERCENTILE) return undefined;
  const threshold = nanoPercentile(
    pool.map((model) => combinedRateNanoUsd(model)),
    PREMIUM_PRICE_PERCENTILE
  );
  /* v8 ignore next -- unreachable: the length guard above admits only non-empty
     pools, for which the percentile always selects a member */
  if (threshold === undefined) return undefined;
  return nanoUSD(threshold);
}

/**
 * The model's combined billable per-token rate — the single quantity both the
 * premium threshold and the candidate price order compare: its anchor's base
 * input and output rates added.
 */
export function combinedRateNanoUsd(model: PriceableModel): NanoUSD {
  return combinedAnchorRateNanoUsd(model.pricing);
}

export interface PremiumClassificationInput {
  readonly model: PriceableModel;
  /**
   * The combined billable per-token rate at/above which a model is premium —
   * {@link premiumPriceThresholdNanoUsd} of the exposed pool, resolved by the
   * caller that holds the pool. `undefined` when the pool is too small to have a
   * threshold, which disables the PRICE leg alone: recency still decides.
   */
  readonly priceThresholdNanoUsd?: NanoUSD | undefined;
  /**
   * The reference clock. An argument, not `Date.now()`: this module reads no
   * clock, so a classification is reproducible from its inputs alone.
   */
  readonly nowMs: number;
}

/**
 * Premium iff the combined billable rate is at or above the threshold, OR the
 * model was released inside {@link PREMIUM_RECENCY_MS}. Basic otherwise.
 * Classification is computed from the catalog, never stored.
 */
export function isPremiumModel(input: PremiumClassificationInput): boolean {
  const { model, priceThresholdNanoUsd, nowMs } = input;
  if (
    priceThresholdNanoUsd !== undefined &&
    combinedRateNanoUsd(model) >= BigInt(priceThresholdNanoUsd)
  ) {
    return true;
  }
  return model.releasedAtMs > nowMs - PREMIUM_RECENCY_MS;
}

/**
 * Whether a model's worst-case trial turn runs past the trial per-message cap.
 * The worst case is the trial turn {@link trialTurnCostNanoUsd} prices: input
 * tokens plus `TRIAL_AFFORDABILITY_MULTIPLIER × MINIMUM_OUTPUT_TOKENS` output
 * tokens, provider cost only, because a trial turn never persists.
 *
 * `promptChars` is the input-character basis to price the worst case over: the
 * turn's real `promptChars` where one exists, and a representative fixed count
 * where the question is "may this model ever be used on trial" rather than "can
 * this turn send". The caller chooses, because those are different questions and
 * a classification that moved with what a user typed would be the wrong one.
 */
export function exceedsTrialBudget(model: PriceableModel, promptChars: number): boolean {
  if (!Number.isSafeInteger(promptChars) || promptChars < 0) {
    throw new RangeError('exceedsTrialBudget: promptChars must be a non-negative integer');
  }
  return trialTurnCostNanoUsd(model.pricing, promptChars) > TRIAL_MESSAGE_COST_CAP_NANO_USD;
}
