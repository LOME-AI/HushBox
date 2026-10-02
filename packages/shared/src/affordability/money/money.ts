/**
 * Money primitives over integer `bigint` counts: nano-USD for every ledger
 * amount, pico-USD (10⁻¹² USD) for a figure held at sub-nano precision. This
 * module reads a float USD figure, such as the gateway's inline
 * per-generation cost, through its fixed decimal rendering (`usdToPicoUsd`),
 * so no float multiplication touches an amount.
 *
 * Fee-seam: this module is where markup application is DEFINED; the vendored
 * fee-seams lint rule confines importers to the sanctioned seams and matches
 * by name pattern — every fee-application helper here must keep the
 * `applyMarkup` prefix so new helpers stay covered.
 */

const BASIS = 10_000n;

/**
 * The 15%-over-provider-cost markup in basis points, kept as an exact bigint
 * (float rate math is banned on money). The billing slice's drift guard fails
 * fast if the shared marketing-facing `TOTAL_FEE_RATE` ever diverges from this
 * money-path constant.
 */
export const MARKUP_BASIS_POINTS = 1500n;

const NANO_FRACTION_DIGITS = 9;
/** toFixed precision for the float→decimal rendering: one digit per pico. */
const RENDER_DIGITS = 12;
const PICO_PER_NANO = 10n ** BigInt(RENDER_DIGITS - NANO_FRACTION_DIGITS);

/**
 * Integer division with banker's rounding: midpoints go to the even
 * neighbor, everything else to the nearest. Symmetric for negatives.
 */
export function roundHalfEvenDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('roundHalfEvenDiv: denominator must be positive');
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const doubled = remainder * 2n;
  let rounded = quotient;
  if (doubled > denominator || (doubled === denominator && quotient % 2n === 1n)) {
    rounded = quotient + 1n;
  }
  return negative ? -rounded : rounded;
}

/**
 * The markup over a pico-USD base cost, rounded half-even to nano exactly
 * once. The port's charge conversion reads the provider's cost at pico
 * precision and marks it up here: rounding to nano before the markup as well
 * can land a charge off the nano grid one nano above the baked rate times its tokens.
 */
export function applyMarkupFromPicoUsd(basePicoUsd: bigint): bigint {
  if (basePicoUsd < 0n) {
    throw new RangeError('applyMarkupFromPicoUsd: negative base cost is rejected, never credited');
  }
  return roundHalfEvenDiv(basePicoUsd * (BASIS + MARKUP_BASIS_POINTS), BASIS * PICO_PER_NANO);
}

/** {@link applyMarkupFromPicoUsd} over a whole-nano base cost. */
export function applyMarkup(baseCostNanoUsd: bigint): bigint {
  return applyMarkupFromPicoUsd(baseCostNanoUsd * PICO_PER_NANO);
}

/**
 * Ceil-rounding sibling of {@link applyMarkup}, rounding against the user
 * (BILLING.md §Fee Structure): the result is never below 1.15× the nano base
 * it is given. A base already rounded from a finer vendor rate can sit below
 * that rate, so {@link applyMarkupCeilFromUsdDecimal} holds the bound against
 * the vendor's decimal. Half-even stays reserved for the port's charge
 * conversion.
 */
export function applyMarkupCeil(baseCostNanoUsd: bigint): bigint {
  if (baseCostNanoUsd < 0n) {
    throw new RangeError('applyMarkupCeil: negative base cost is rejected, never credited');
  }
  const exact = baseCostNanoUsd * (BASIS + MARKUP_BASIS_POINTS);
  return (exact + BASIS - 1n) / BASIS;
}

const DECIMAL_USD_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * {@link applyMarkupCeil} over a vendor's decimal USD rate string, taken whole:
 * the digits past nano precision stay in the product, so the one round-up is
 * the only rounding the rate ever sees. Rounding the rate to nano first can
 * store a rate below the exact 1.15× figure, and the hold built on it can
 * sit below the bill. An unparseable or negative rate returns `undefined`.
 */
export function applyMarkupCeilFromUsdDecimal(rate: string): bigint | undefined {
  if (!DECIMAL_USD_PATTERN.test(rate)) return undefined;
  const [whole = '', fraction = ''] = rate.split('.');
  const scale = BASIS * 10n ** BigInt(fraction.length);
  const exact =
    BigInt(whole + fraction) * 10n ** BigInt(NANO_FRACTION_DIGITS) * (BASIS + MARKUP_BASIS_POINTS);
  return (exact + scale - 1n) / scale;
}

/**
 * The inverse of the markup over a billable nano-USD amount: the largest
 * pico-USD base whose exact 1.15× value does not exceed it. Rounding down is
 * what keeps every base at or below the result within the billable amount.
 */
export function applyMarkupInverseFloorToPicoUsd(billableNanoUsd: bigint): bigint {
  if (billableNanoUsd < 0n) {
    throw new RangeError('applyMarkupInverseFloorToPicoUsd: negative amount is rejected');
  }
  return (billableNanoUsd * PICO_PER_NANO * BASIS) / (BASIS + MARKUP_BASIS_POINTS);
}

/**
 * Float-USD → an integer count of 10⁻¹² USD, read from the number's fixed
 * decimal rendering, so no float multiplication touches the amount.
 */
export function usdToPicoUsd(usd: number): bigint {
  if (!Number.isFinite(usd)) {
    throw new RangeError('usdToPicoUsd: amount must be finite');
  }
  if (usd < 0) {
    throw new RangeError('usdToPicoUsd: negative amounts are rejected, never credited');
  }
  const [whole = '0', fraction = ''] = usd.toFixed(RENDER_DIGITS).split('.');
  return BigInt(whole + fraction);
}

/** Float-USD → nano-USD: {@link usdToPicoUsd}, the sub-nano residue rounded half-even. */
export function usdToNanoUsd(usd: number): bigint {
  return roundHalfEvenDiv(usdToPicoUsd(usd), PICO_PER_NANO);
}
