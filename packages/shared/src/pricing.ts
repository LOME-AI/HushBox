import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
} from './constants.js';
import type { UserTier } from './tiers.js';

/**
 * Parse a token price string from the AI Gateway model metadata.
 * Returns 0 for negative sentinel values (e.g. "-1" = "variable pricing")
 * and for NaN/missing values.
 */
export function parseTokenPrice(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) || value < 0 ? 0 : value;
}

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
 * Apply all fees (HushBox + CC + Provider) to a base price.
 * SINGLE SOURCE OF TRUTH for fee application.
 *
 * Used by:
 * - Model selector to show per-token pricing with fees
 * - calculateTokenCostWithFees as building block
 *
 * Fee breakdown (15% total):
 * - 5% HushBox profit margin
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
  /** Tokens used for input (from the AI Gateway) */
  inputTokens: number;
  /** Tokens used for output (from the AI Gateway) */
  outputTokens: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
  /** Model's price per input token in USD */
  pricePerInputToken: number;
  /** Model's price per output token in USD */
  pricePerOutputToken: number;
  /** Per-search cost in USD (base price, fees will be applied). 0 or omitted if no search. */
  webSearchCost?: number;
}

/**
 * Estimate message cost for development environment using token counts.
 *
 * Use this when exact AI Gateway generation stats are not available (local development).
 * For production, use calculateMessageCostFromActual with exact costs.
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
    webSearchCost = 0,
  } = params;

  const tokenCostWithFees = calculateTokenCostWithFees(
    inputTokens,
    outputTokens,
    pricePerInputToken,
    pricePerOutputToken
  );

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return tokenCostWithFees + storageFee + applyFees(webSearchCost);
}

export interface MessageCostFromActualParams {
  /** Exact cost in USD from the AI gateway's getGenerationInfo endpoint */
  gatewayCost: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
}

/**
 * Calculate message cost using the AI gateway's exact cost.
 * SINGLE SOURCE OF TRUTH for billing based on actual usage.
 *
 * The gateway's totalCost includes any web search tool calls, caching discounts,
 * and tiered pricing. This function adds HushBox fees and storage cost on top.
 *
 * Components:
 * 1. Model cost with fees: gatewayCost × (1 + TOTAL_FEE_RATE)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 */
export function calculateMessageCostFromActual(params: MessageCostFromActualParams): number {
  const { gatewayCost, inputCharacters, outputCharacters } = params;

  const modelCostWithFees = applyFees(gatewayCost);

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

/**
 * Compute fee-inclusive model pricing from raw per-token prices.
 * SINGLE SOURCE OF TRUTH for extracting model pricing with fees applied.
 *
 * Accepts raw (pre-fee) prices — callers parse strings or pass numbers directly.
 * Returns fee-inclusive prices ready for budget calculation.
 */
export interface ModelPricingResult {
  inputPricePerToken: number;
  outputPricePerToken: number;
  contextLength: number;
}

export function getModelPricing(
  inputPricePerToken: number,
  outputPricePerToken: number,
  contextLength: number
): ModelPricingResult {
  return {
    inputPricePerToken: applyFees(inputPricePerToken),
    outputPricePerToken: applyFees(outputPricePerToken),
    contextLength,
  };
}

/**
 * Effective cost per output token: model cost + estimated storage cost.
 *
 * Output is tokens→chars: INVERTED from input (chars→tokens).
 * Free/trial/guest: STANDARD (4 chars/tok) → pessimistic (more storage budgeted).
 * Paid: CONSERVATIVE (2 chars/tok) → optimistic (less storage, cushion absorbs overruns).
 */
export function effectiveOutputCostPerToken(
  modelOutputPricePerToken: number,
  tier: UserTier
): number {
  const outputCharsPerToken =
    tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
  const storageCostPerToken = outputCharsPerToken * STORAGE_COST_PER_CHARACTER;
  return modelOutputPricePerToken + storageCostPerToken;
}
