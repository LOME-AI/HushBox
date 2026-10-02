/**
 * Customer-facing price DISPLAY formatters over the canonical nano-USD wire.
 *
 * The rates they render are BILLABLE (fee-inclusive) nano-USD — fees are baked
 * at the catalog-ingestion seam — so these are pure renderers: no fee math
 * anywhere. All money arithmetic stays in integer `bigint`; a value
 * is only rendered to a human-readable dollar STRING at the very end (never
 * float money math).
 */

import { EXPENSIVE_MODEL_THRESHOLD_PER_1K } from '../constants.ts';
import { roundHalfEvenDiv, usdToNanoUsd } from '../money/money.ts';
import { nanoUsdToFullDollarString } from '../money/nano-usd.ts';

/** Tokens per "per-1k" display unit. */
const TOKENS_PER_DISPLAY_UNIT = 1000n;

/** Nano fractional digits in a full-precision dollar string (`X.fffffffff`). */
const NANO_FRACTION_DIGITS = 9;

/**
 * The expensive-model warning threshold in nano-USD per 1k tokens, derived once
 * from the single canonical `EXPENSIVE_MODEL_THRESHOLD_PER_1K` USD constant — not
 * mirrored — so the display comparison stays in exact integer nano.
 */
const EXPENSIVE_MODEL_THRESHOLD_PER_1K_NANO = usdToNanoUsd(EXPENSIVE_MODEL_THRESHOLD_PER_1K);

/**
 * A BILLABLE per-token nano rate as its per-1k dollar figure, without the sign,
 * trailing zeros (and a bare dot) stripped.
 */
function per1kFigure(billableNanoPerToken: bigint): string {
  const per1kNano = billableNanoPerToken * TOKENS_PER_DISPLAY_UNIT;
  return nanoUsdToFullDollarString(per1kNano.toString()).replace(/\.?0+$/, '');
}

/** A non-negative nano bigint as `$X.d…` with exactly `fractionDigits` decimals, half-even. */
function fixedDollars(nano: bigint, fractionDigits: number): string {
  const scale = 10n ** BigInt(NANO_FRACTION_DIGITS - fractionDigits);
  const units = roundHalfEvenDiv(nano, scale);
  const divisor = 10n ** BigInt(fractionDigits);
  const whole = units / divisor;
  const fraction = units % divisor;
  return `$${whole.toString()}.${fraction.toString().padStart(fractionDigits, '0')}`;
}

/**
 * Customer price for 1,000 tokens of a BILLABLE per-token nano rate, rendered
 * `$X` with trailing zeros stripped (e.g. `$0.00115`). A pure renderer — the
 * rate arrives already fee-inclusive.
 */
export function nanoPricePer1k(billableNanoPerToken: bigint): string {
  return `$${per1kFigure(billableNanoPerToken)}`;
}

/**
 * Customer price-RANGE per 1k tokens for the Smart-Model min/max pool bounds
 * (e.g. `$0.00115 – $0.0023 / 1k`). Both bounds are BILLABLE nano rates.
 */
export function nanoPriceRangePer1k(
  minBillableNanoPerToken: bigint,
  maxBillableNanoPerToken: bigint
): string {
  return `${nanoPricePer1k(minBillableNanoPerToken)} – ${nanoPricePer1k(maxBillableNanoPerToken)} / 1k`;
}

/**
 * The compact per-1k form of one BILLABLE rate or a min–max pair: one dollar
 * sign, no spaces, the unit after (`$0.00345/1k`, `$0.000035–0.0345/1k`). A
 * range keeps both figures even when the bounds are equal, so it always carries
 * the two figures {@link nanoPriceRangePer1k} prints.
 */
export function nanoRateCompactPer1k(
  minBillableNanoPerToken: bigint,
  maxBillableNanoPerToken?: bigint
): string {
  const low = per1kFigure(minBillableNanoPerToken);
  const figures =
    maxBillableNanoPerToken === undefined ? low : `${low}–${per1kFigure(maxBillableNanoPerToken)}`;
  return `$${figures}/1k`;
}

/**
 * Whether a text model's billable combined (input + output) cost per 1k tokens
 * reaches the expensive-model warning threshold ($0.10). Inputs are BILLABLE
 * nano per-token rates; the comparison is a pure sum.
 */
export function isExpensiveModelNano(
  billableInputNanoPerToken: bigint,
  billableOutputNanoPerToken: bigint
): boolean {
  const combinedPer1k =
    (billableInputNanoPerToken + billableOutputNanoPerToken) * TOKENS_PER_DISPLAY_UNIT;
  return combinedPer1k >= EXPENSIVE_MODEL_THRESHOLD_PER_1K_NANO;
}

/**
 * Customer price for a single BILLABLE nano unit rate (per-image or
 * per-second), rendered `$X.d…` at a fixed decimal precision (`fractionDigits`
 * ≤ 9). Used by the per-image and per-second media displays.
 */
export function nanoUnitPriceUsd(billableNano: bigint, fractionDigits: number): string {
  return fixedDollars(billableNano, fractionDigits);
}
