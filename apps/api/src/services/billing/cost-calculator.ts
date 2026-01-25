import {
  estimateTokenCount,
  estimateMessageCostDevelopment,
  calculateMessageCostFromOpenRouter,
} from '@lome-chat/shared';

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
}

/**
 * Calculate message cost based on client type and available data.
 * Real client (isMock=false) with generationId: uses exact OpenRouter stats.
 * Mock client (isMock=true) or without generationId: estimates from character count.
 */
export async function calculateMessageCost(params: CalculateMessageCostParams): Promise<number> {
  const { openrouter, modelInfo, generationId, inputContent, outputContent } = params;

  const inputCharacters = inputContent.length;
  const outputCharacters = outputContent.length;

  // Real client path: use exact stats from OpenRouter
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
  });
}

interface EstimateCostParams {
  modelInfo: CalculateMessageCostParams['modelInfo'];
  inputContent: string;
  outputContent: string;
  inputCharacters: number;
  outputCharacters: number;
}

function estimateCost(params: EstimateCostParams): number {
  const { modelInfo, inputContent, outputContent, inputCharacters, outputCharacters } = params;
  if (!modelInfo) {
    return 0;
  }

  const pricePerInputToken = Number.parseFloat(modelInfo.pricing.prompt);
  const pricePerOutputToken = Number.parseFloat(modelInfo.pricing.completion);

  return estimateMessageCostDevelopment({
    inputTokens: estimateTokenCount(inputContent),
    outputTokens: estimateTokenCount(outputContent),
    pricePerInputToken,
    pricePerOutputToken,
    inputCharacters,
    outputCharacters,
  });
}
