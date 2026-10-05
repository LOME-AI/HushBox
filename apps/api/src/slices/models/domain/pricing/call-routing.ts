import { anchorBaseRatesNanoUsd } from '@hushbox/shared/affordability/price/display';
import { callCeilingRates } from '@hushbox/shared/affordability/price/reservation';
import { tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import { billableRatesToMaxPrice } from '../../../billing/public/routing-cap.js';
import type { MaxPrice } from '@hushbox/shared';
import type { ModelPricing } from '@hushbox/shared/affordability/price/schedule';

/**
 * A language call's `max_price`: the ceiling its input bound reaches (the
 * anchor's own dearest tier, or a larger-context segment the bound passes
 * into), un-baked into the wire's USD per million. One value serves every step
 * of the call. The bound is a true upper bound on the prompt, never the
 * 3-characters estimate, so a dense script cannot cross a segment unseen.
 */
export function callMaxPrice(pricing: ModelPricing, inputTokenUpperBound: number): MaxPrice {
  const tokens = tokenPricingOf(pricing);
  if (tokens === undefined) {
    throw new Error('callMaxPrice: only a token price caps a language call');
  }
  return billableRatesToMaxPrice(callCeilingRates(tokens, inputTokenUpperBound));
}

/** A `max_price` rate read as the integer count of micro-USD per million it states. */
function microUsdPerMillion(rate: string): bigint {
  return BigInt(rate.replace('.', ''));
}

/**
 * Whether a cap admits the model's cheapest endpoint: both of its rates at or
 * above the anchor's base rates un-baked, which is how the gateway compares
 * `max_price` with an endpoint's listed price. A media price routes no cap, so
 * every cap admits it.
 */
export function maxPriceReachesAnchor(maxPrice: MaxPrice, pricing: ModelPricing): boolean {
  const tokens = tokenPricingOf(pricing);
  if (tokens === undefined) return true;
  const cheapest = billableRatesToMaxPrice(anchorBaseRatesNanoUsd(tokens));
  return (
    microUsdPerMillion(maxPrice.prompt) >= microUsdPerMillion(cheapest.prompt) &&
    microUsdPerMillion(maxPrice.completion) >= microUsdPerMillion(cheapest.completion)
  );
}
