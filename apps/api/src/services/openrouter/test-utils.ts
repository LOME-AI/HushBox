import type { OpenRouterClient } from './types.js';

/** Fallback model if no cheap paid model is found */
const FALLBACK_PAID_MODEL = 'openai/gpt-4o-mini';

/** Maximum price per token (prompt or completion) for test models */
const MAX_TEST_MODEL_PRICE = 0.00001;

let cachedPaidModel: string | null = null;

/**
 * Clear the cached test model. Exposed for testing purposes.
 */
export function clearTestModelCache(): void {
  cachedPaidModel = null;
}

/**
 * Get a cheap paid model for billing integration tests.
 * Finds the cheapest available paid model (non-zero pricing, below max price).
 * Falls back to gpt-4o-mini if no suitable model is found.
 * Results are cached to avoid repeated API calls.
 */
export async function getPaidTestModel(client: OpenRouterClient): Promise<string> {
  if (cachedPaidModel) {
    return cachedPaidModel;
  }

  const models = await client.listModels();

  // Find cheapest paid model within price threshold
  const cheapPaidModels = models.filter((model) => {
    const promptPrice = parseFloat(model.pricing.prompt);
    const completionPrice = parseFloat(model.pricing.completion);

    // Exclude free models (price = 0)
    // Exclude invalid models (price < 0, used for "no prompt" models)
    // Exclude expensive models above threshold
    return (
      promptPrice > 0 &&
      completionPrice > 0 &&
      promptPrice <= MAX_TEST_MODEL_PRICE &&
      completionPrice <= MAX_TEST_MODEL_PRICE
    );
  });

  if (cheapPaidModels.length === 0) {
    cachedPaidModel = FALLBACK_PAID_MODEL;
    return cachedPaidModel;
  }

  // Sort by total price (prompt + completion)
  cheapPaidModels.sort((a, b) => {
    const totalA = parseFloat(a.pricing.prompt) + parseFloat(a.pricing.completion);
    const totalB = parseFloat(b.pricing.prompt) + parseFloat(b.pricing.completion);
    return totalA - totalB;
  });

  const cheapestModel = cheapPaidModels[0];
  cachedPaidModel = cheapestModel ? cheapestModel.id : FALLBACK_PAID_MODEL;
  return cachedPaidModel;
}
