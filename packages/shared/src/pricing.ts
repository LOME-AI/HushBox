import { LOME_FEE_RATE, STORAGE_COST_PER_CHARACTER } from './constants.js';

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
 * 1. Model cost: (inputTokens × pricePerInputToken) + (outputTokens × pricePerOutputToken)
 * 2. LOME fee: modelCost × LOME_FEE_RATE (15%)
 * 3. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 *
 * Storage fee applies only to new messages (input + output), not conversation history.
 * LOME fee applies only to model cost, not to storage fee.
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

  // Model usage cost (what we pay OpenRouter)
  const modelCost = inputTokens * pricePerInputToken + outputTokens * pricePerOutputToken;

  // LOME's markup on model usage (not applied to storage)
  const lomeFee = modelCost * LOME_FEE_RATE;

  // Storage fee for input and output characters
  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return modelCost + lomeFee + storageFee;
}
