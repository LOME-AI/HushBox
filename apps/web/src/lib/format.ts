import { LOME_FEE_RATE } from '@lome-chat/shared';

/**
 * Apply LOME's fee to a price.
 * Use this when displaying prices to users to show what they'll actually pay.
 */
export function applyLomeFee(price: number): number {
  return price * (1 + LOME_FEE_RATE);
}

/**
 * Format context length for display.
 * Examples: 128000 → "128k", 1000000 → "1M"
 */
export function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${String(Math.round(length / 1000000))}M`;
  }
  return `${String(Math.round(length / 1000))}k`;
}

/**
 * Format price per token to price per 1k tokens.
 * Shows exact values without rounding, limited to 10 decimal places to avoid floating point artifacts.
 * Examples: 0.00001 → "$0.01", 0.000003 → "$0.003", 0.0000105 → "$0.0105"
 */
export function formatPricePer1k(pricePerToken: number): string {
  const pricePer1k = pricePerToken * 1000;
  // Use toFixed(10) to avoid floating point artifacts, then strip trailing zeros
  const fixed = pricePer1k.toFixed(10);
  const stripped = fixed.replace(/\.?0+$/, '');
  return `$${stripped}`;
}
