/**
 * Safe max_tokens calculation for OpenRouter requests.
 *
 * Handles the case where budget-based maxOutputTokens exceeds what the model can actually use.
 * When user has high balance + cheap model, budget calculation can return millions of tokens,
 * but OpenRouter rejects requests where max_tokens + input > context_length.
 */

/** 5% safety margin to account for token estimation inaccuracy */
const MAX_TOKENS_HEADROOM = 0.95;

export interface ComputeMaxTokensParams {
  /** Max output tokens based on user's budget */
  budgetMaxTokens: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
  /** Estimated input tokens (system prompt + history + user message) */
  estimatedInputTokens: number;
}

/**
 * Compute safe max_tokens value for OpenRouter request.
 *
 * @returns undefined if budget exceeds remaining context (omit max_tokens, let model use default)
 * @returns budget * 0.95 if budget is the limiting factor (5% headroom for estimation error)
 */
export function computeSafeMaxTokens(params: ComputeMaxTokensParams): number | undefined {
  const remainingContext = params.modelContextLength - params.estimatedInputTokens;

  if (params.budgetMaxTokens >= remainingContext) {
    return undefined;
  }

  return Math.floor(params.budgetMaxTokens * MAX_TOKENS_HEADROOM);
}
