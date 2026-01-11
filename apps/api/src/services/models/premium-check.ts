/**
 * Premium model classification service.
 *
 * Handles premium model classification and access control.
 */

import type { OpenRouterModel } from '../models.js';

/** Percentile threshold for premium pricing (0.75 = 75th percentile) */
export const PREMIUM_PRICE_PERCENTILE = 0.75;

/** Recency threshold for premium models (1 year in milliseconds) */
export const PREMIUM_RECENCY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Check if a model is premium based on price threshold and recency.
 *
 * A model is considered premium if:
 * - Its combined price (prompt + completion) >= price threshold, OR
 * - It was released within the last year
 *
 * @param model - The OpenRouter model to check
 * @param priceThreshold - The price threshold (combined prompt + completion per token)
 * @returns true if the model is premium
 */
export function isPremiumModel(model: OpenRouterModel, priceThreshold: number): boolean {
  const price = parseFloat(model.pricing.prompt) + parseFloat(model.pricing.completion);
  const recencyThreshold = Date.now() - PREMIUM_RECENCY_MS;
  return price >= priceThreshold || model.created * 1000 > recencyThreshold;
}
