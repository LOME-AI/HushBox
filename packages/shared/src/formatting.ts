/**
 * Formatting utilities for consistent display across the application.
 * Single source of truth for number, cost, and context length formatting.
 */

/**
 * Format a number with locale-specific thousand separators.
 *
 * @param num - The number to format
 * @returns Formatted string (e.g., "1,234,567")
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Format a context length (token count) for display.
 * Large numbers are abbreviated with K or M suffixes.
 *
 * @param length - Context length in tokens
 * @returns Formatted string (e.g., "128k", "1M")
 */
export function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${String(Math.round(length / 1000000))}M`;
  }
  return `${String(Math.round(length / 1000))}k`;
}

/**
 * Format a price per 1000 tokens for display.
 * Strips trailing zeros for cleaner display.
 *
 * @param pricePerToken - Price per single token
 * @returns Formatted string (e.g., "$0.01")
 */
export function formatPricePer1k(pricePerToken: number): string {
  const pricePer1k = pricePerToken * 1000;
  const fixed = pricePer1k.toFixed(10);
  const stripped = fixed.replace(/\.?0+$/, '');
  return `$${stripped}`;
}

/**
 * Format a cost value for display.
 * Uses variable precision based on magnitude:
 * - Very small costs (< $0.0001): 6 decimal places
 * - Normal costs: 4 decimal places
 * - Zero: "$0.00"
 *
 * @param cost - Cost as string or number
 * @returns Formatted string (e.g., "$0.0234")
 */
export function formatCost(cost: string | number): string {
  const numericCost = typeof cost === 'string' ? parseFloat(cost) : cost;

  if (isNaN(numericCost) || numericCost === 0) {
    return '$0.00';
  }

  // For very small costs (< $0.0001), show more precision
  if (numericCost < 0.0001) {
    return `$${numericCost.toFixed(6)}`;
  }

  // For normal costs, show 4 decimal places
  return `$${numericCost.toFixed(4)}`;
}
