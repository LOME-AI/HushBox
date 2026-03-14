import {
  estimateTokenCount,
  estimateMessageCostDevelopment,
  calculateMessageCostFromOpenRouter,
  parseTokenPrice,
} from '@hushbox/shared';

export interface CalculateMessageCostParams {
  openrouter: {
    /** True for mock client (dev), false for real client (CI/production) */
    isMock: boolean;
    getGenerationStats: (generationId: string) => Promise<{ total_cost: number }>;
  };
  modelInfo:
    | {
        id: string;
        pricing: { prompt: string; completion: string };
      }
    | undefined;
  generationId: string | undefined;
  inputContent: string;
  outputContent: string;
  /** Per-search cost in USD (base price before fees). 0 when search disabled. Only used in mock/estimation path. */
  webSearchCost: number;
}

/**
 * Calculate message cost based on client type and available data.
 * Real client (isMock=false) with generationId: uses exact OpenRouter stats (includes search cost).
 * Mock client (isMock=true) or without generationId: estimates from character count + webSearchCost.
 */
export async function calculateMessageCost(params: CalculateMessageCostParams): Promise<number> {
  const { openrouter, modelInfo, generationId, inputContent, outputContent, webSearchCost } =
    params;

  const inputCharacters = inputContent.length;
  const outputCharacters = outputContent.length;

  // Real client path: use exact stats from OpenRouter (total_cost already includes search charges)
  if (!openrouter.isMock && generationId) {
    try {
      const stats = await openrouter.getGenerationStats(generationId);
      return calculateMessageCostFromOpenRouter({
        openRouterCost: stats.total_cost,
        inputCharacters,
        outputCharacters,
      });
    } catch {
      // Fall back to estimation if stats fetch fails
      return estimateCost({
        modelInfo,
        inputContent,
        outputContent,
        inputCharacters,
        outputCharacters,
        webSearchCost,
      });
    }
  }

  // Mock client path: estimate from character count
  return estimateCost({
    modelInfo,
    inputContent,
    outputContent,
    inputCharacters,
    outputCharacters,
    webSearchCost,
  });
}

interface EstimateCostParams {
  modelInfo: CalculateMessageCostParams['modelInfo'];
  inputContent: string;
  outputContent: string;
  inputCharacters: number;
  outputCharacters: number;
  webSearchCost: number;
}

function estimateCost(params: EstimateCostParams): number {
  const {
    modelInfo,
    inputContent,
    outputContent,
    inputCharacters,
    outputCharacters,
    webSearchCost,
  } = params;
  if (!modelInfo) {
    return 0;
  }

  const pricePerInputToken = parseTokenPrice(modelInfo.pricing.prompt);
  const pricePerOutputToken = parseTokenPrice(modelInfo.pricing.completion);

  return estimateMessageCostDevelopment({
    inputTokens: estimateTokenCount(inputContent),
    outputTokens: estimateTokenCount(outputContent),
    pricePerInputToken,
    pricePerOutputToken,
    inputCharacters,
    outputCharacters,
    webSearchCost,
  });
}
