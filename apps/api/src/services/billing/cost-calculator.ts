import {
  estimateTokenCount,
  estimateMessageCostDevelopment,
  calculateMessageCostFromOpenRouter,
} from '@lome-chat/shared';

export interface CalculateMessageCostParams {
  openrouter: {
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
  isProduction: boolean;
}

/**
 * Calculate message cost based on environment and available data.
 * In production with generationId: uses exact OpenRouter stats.
 * In development or without generationId: estimates from character count.
 */
export async function calculateMessageCost(params: CalculateMessageCostParams): Promise<number> {
  const { openrouter, modelInfo, generationId, inputContent, outputContent, isProduction } = params;

  const inputCharacters = inputContent.length;
  const outputCharacters = outputContent.length;

  // Production path: use exact stats from OpenRouter
  if (isProduction && generationId) {
    try {
      const stats = await openrouter.getGenerationStats(generationId);
      return calculateMessageCostFromOpenRouter({
        openRouterCost: stats.total_cost,
        inputCharacters,
        outputCharacters,
      });
    } catch {
      // Fall back to estimation if stats fetch fails
      return estimateCost(
        modelInfo,
        inputContent,
        outputContent,
        inputCharacters,
        outputCharacters
      );
    }
  }

  // Development path: estimate from character count
  return estimateCost(modelInfo, inputContent, outputContent, inputCharacters, outputCharacters);
}

function estimateCost(
  modelInfo: CalculateMessageCostParams['modelInfo'],
  inputContent: string,
  outputContent: string,
  inputCharacters: number,
  outputCharacters: number
): number {
  if (!modelInfo) {
    return 0;
  }

  const pricePerInputToken = parseFloat(modelInfo.pricing.prompt);
  const pricePerOutputToken = parseFloat(modelInfo.pricing.completion);

  return estimateMessageCostDevelopment({
    inputTokens: estimateTokenCount(inputContent),
    outputTokens: estimateTokenCount(outputContent),
    pricePerInputToken,
    pricePerOutputToken,
    inputCharacters,
    outputCharacters,
  });
}
