import { TOTAL_FEE_RATE, STORAGE_COST_PER_CHARACTER } from './constants.js';

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
 * Calculate the total cost of a message including model usage and storage fees.
 *
 * This is the SINGLE SOURCE OF TRUTH for message costs.
 *
 * Components:
 * 1. Token cost with fees: uses calculateTokenCostWithFees (includes 15% markup)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 *
 * Storage fee applies only to new messages (input + output), not conversation history.
 * Fees (15%) apply only to model cost, not to storage fee.
 */
export function calculateMessageCost(params: MessageCostParams): number {
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
