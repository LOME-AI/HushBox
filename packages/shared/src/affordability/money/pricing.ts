import { TOTAL_FEE_RATE } from '../constants.ts';

/**
 * Apply the total fee to a RAW base price (a price NOT already fee-inclusive).
 * SINGLE SOURCE OF TRUTH for float fee application. Model catalog rates are
 * already fee-inclusive (baked at catalog ingestion), so this is only for raw
 * constants/inputs (e.g. the marketing fee-breakdown display).
 *
 * The total fee rate is the sum of every non-zero category in FEE_CATEGORIES
 * (see `./fees.ts`). Setting any individual rate to 0 cascades through every
 * pricing surface automatically.
 */
export function applyFees(basePrice: number): number {
  return basePrice * (1 + TOTAL_FEE_RATE);
}
