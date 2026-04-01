import {
  estimateTokenCount,
  estimateMessageCostDevelopment,
  calculateMessageCostFromOpenRouter,
  parseTokenPrice,
} from '@hushbox/shared';

export interface CalculateMessageCostParams {
  /** Inline cost from OpenRouter's final usage chunk (USD). Undefined if usage chunk was missing. */
  inlineCost: number | undefined;
  modelInfo:
    | {
        id: string;
        pricing: { prompt: string; completion: string };
      }
    | undefined;
  inputContent: string;
  outputContent: string;
  /** Per-search cost in USD (base price before fees). 0 when search disabled. Only used in estimation path. */
  webSearchCost: number;
}

/**
 * Calculate message cost from inline OpenRouter data or estimate.
 * Production: uses exact inline cost from OpenRouter stream.
 * Development/fallback: estimates from character count.
 */
export function calculateMessageCost(params: CalculateMessageCostParams): number {
  const { inlineCost, modelInfo, inputContent, outputContent, webSearchCost } = params;

  const inputCharacters = inputContent.length;
  const outputCharacters = outputContent.length;

  // Production path: use exact inline cost from OpenRouter stream
  if (inlineCost !== undefined) {
    return calculateMessageCostFromOpenRouter({
      openRouterCost: inlineCost,
      inputCharacters,
      outputCharacters,
    });
  }

  // Fallback: estimate from character count
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
