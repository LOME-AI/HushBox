import {
  MARKUP_BASIS_POINTS,
  TOTAL_FEE_RATE,
  applyMarkupFromPicoUsd,
  applyMarkupInverseFloorToPicoUsd,
  usdToPicoUsd,
} from '@hushbox/shared';

/**
 * Money math for the billing slice and the ModelProvider port's fee seam. The
 * nano-USD primitives and the storage nano rates are canonical in
 * `@hushbox/shared` and re-exported here for the slice's callers. The port's
 * charge conversion and the routing cap's un-bake live here, and each reaches
 * the markup only through a shared `applyMarkup*` helper. The markup drift
 * guard (against the shared `TOTAL_FEE_RATE` float) runs at module init; the
 * storage rates have no float mirror to guard, since the nano value is their
 * single source of truth.
 */
export { MARKUP_BASIS_POINTS, applyMarkup, roundHalfEvenDiv, usdToNanoUsd } from '@hushbox/shared';
export { STORAGE_COST_PER_CHARACTER_NANO, MEDIA_STORAGE_COST_PER_BYTE_NANO } from '@hushbox/shared';

/** A pico-USD-per-token count is the same integer as micro-USD per million tokens. */
const PER_MILLION_FRACTION_DIGITS = 6;

/**
 * The ModelProvider port's charge conversion, one of the fee seams BILLING.md
 * §Fee Structure names. Converts the provider's inline `usage.cost` (raw USD)
 * to the billable nano-USD amount settlement charges as-is: the cost is read
 * as an integer count of 10⁻¹² USD and marked up with one half-even rounding.
 * Raw provider cost is never retained past this call.
 */
export function providerUsdToBillableNanoUsd(usd: number): bigint {
  return applyMarkupFromPicoUsd(usdToPicoUsd(usd));
}

/**
 * The routing cap: a billable nano rate un-baked to the provider rate it
 * covers, as the `max_price` wire's USD per million. It divides out the markup
 * the ingestion bake multiplies in, is never a charge, and exists only on the
 * outgoing request. It rounds down, so every rate the vendor may serve under
 * it is at most the billable rate ÷ 1.15, and
 * {@link providerUsdToBillableNanoUsd}'s one rounding of that served cost never
 * exceeds the billable rate times the tokens.
 */
export function billableRateToMaxPriceUsdPerMillion(billableNanoPerToken: bigint): string {
  const picoPerToken = applyMarkupInverseFloorToPicoUsd(billableNanoPerToken);
  const digits = picoPerToken.toString().padStart(PER_MILLION_FRACTION_DIGITS + 1, '0');
  return `${digits.slice(0, -PER_MILLION_FRACTION_DIGITS)}.${digits.slice(-PER_MILLION_FRACTION_DIGITS)}`;
}

/** Fail-fast guard, run at module init: the two rate constants must agree. */
export function assertMarkupMatchesSharedRate(totalFeeRate: number): void {
  if (BigInt(Math.round(totalFeeRate * 10_000)) !== MARKUP_BASIS_POINTS) {
    throw new Error(
      'billing: MARKUP_BASIS_POINTS no longer matches the shared TOTAL_FEE_RATE — update both together'
    );
  }
}

assertMarkupMatchesSharedRate(TOTAL_FEE_RATE);
