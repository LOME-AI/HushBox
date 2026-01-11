import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
} from './constants.js';

/**
 * Estimate token count from text using character-based heuristic.
 * Uses ~4 characters per token approximation.
 * This is an approximation - actual tokenization varies by model.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Apply all fees (LOME + CC + Provider) to a base price.
 * SINGLE SOURCE OF TRUTH for fee application.
 *
 * Used by:
 * - Model selector to show per-token pricing with fees
 * - calculateTokenCostWithFees as building block
 *
 * Fee breakdown (15% total):
 * - 5% LOME profit margin
 * - 4.5% credit card processing
 * - 5.5% AI provider overhead
 */
export function applyFees(basePrice: number): number {
  return basePrice * (1 + TOTAL_FEE_RATE);
}

/**
 * Calculate token cost with all fees applied.
 * Used by model selector to show per-token pricing.
 */
export function calculateTokenCostWithFees(
  inputTokens: number,
  outputTokens: number,
  pricePerInputToken: number,
  pricePerOutputToken: number
): number {
  const baseTokenCost = inputTokens * pricePerInputToken + outputTokens * pricePerOutputToken;
  return applyFees(baseTokenCost);
}

export interface MessageCostParams {
  /** Tokens used for input (from OpenRouter) */
  inputTokens: number;
  /** Tokens used for output (from OpenRouter) */
  outputTokens: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
  /** Model's price per input token in USD */
  pricePerInputToken: number;
  /** Model's price per output token in USD */
  pricePerOutputToken: number;
}

/**
 * Estimate message cost for development environment using token counts.
 *
 * Use this when exact OpenRouter stats are not available (local development).
 * For production, use calculateMessageCostFromOpenRouter with exact costs.
 *
 * Components:
 * 1. Token cost with fees: uses calculateTokenCostWithFees (includes 15% markup)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 *
 * Storage fee applies only to new messages (input + output), not conversation history.
 * Fees (15%) apply only to model cost, not to storage fee.
 */
export function estimateMessageCostDevelopment(params: MessageCostParams): number {
  const {
    inputTokens,
    outputTokens,
    inputCharacters,
    outputCharacters,
    pricePerInputToken,
    pricePerOutputToken,
  } = params;

  const tokenCostWithFees = calculateTokenCostWithFees(
    inputTokens,
    outputTokens,
    pricePerInputToken,
    pricePerOutputToken
  );

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return tokenCostWithFees + storageFee;
}

export interface MessageCostFromOpenRouterParams {
  /** Exact cost from OpenRouter's /generation endpoint */
  openRouterCost: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
}

/**
 * Calculate message cost using OpenRouter's exact cost.
 * SINGLE SOURCE OF TRUTH for billing based on actual usage.
 *
 * This function uses the exact cost reported by OpenRouter's /generation endpoint,
 * rather than estimating based on tokens and model pricing.
 *
 * Components:
 * 1. Model cost with fees: openRouterCost × (1 + 15%)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 *
 * The 15% fee covers:
 * - 5% LOME profit margin
 * - 4.5% credit card processing
 * - 5.5% AI provider overhead
 */
export function calculateMessageCostFromOpenRouter(
  params: MessageCostFromOpenRouterParams
): number {
  const { openRouterCost, inputCharacters, outputCharacters } = params;

  const modelCostWithFees = applyFees(openRouterCost);

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return modelCostWithFees + storageFee;
}

/**
 * Get combined model cost per 1k tokens with fees applied.
 * SINGLE SOURCE OF TRUTH for model cost comparison.
 *
 * Used by:
 * - Model selector for sorting
 * - isExpensiveModel() check
 * - Any UI showing combined model cost
 *
 * @param pricePerInputToken - Model's price per input token in USD
 * @param pricePerOutputToken - Model's price per output token in USD
 * @returns Combined cost per 1k tokens with fees applied
 */
export function getModelCostPer1k(pricePerInputToken: number, pricePerOutputToken: number): number {
  const baseCostPer1k = (pricePerInputToken + pricePerOutputToken) * 1000;
  return applyFees(baseCostPer1k);
}

/**
 * Check if a model is considered expensive (>= threshold per 1k tokens with fees).
 *
 * @param pricePerInputToken - Model's price per input token in USD
 * @param pricePerOutputToken - Model's price per output token in USD
 * @returns true if model cost per 1k >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
 */
export function isExpensiveModel(pricePerInputToken: number, pricePerOutputToken: number): boolean {
  return (
    getModelCostPer1k(pricePerInputToken, pricePerOutputToken) >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
  );
}
