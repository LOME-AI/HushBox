import { calculateMessageCostFromActual } from '@hushbox/shared';
import type { AIClient } from '../ai/index.js';

export interface CalculateMessageCostParams {
  /** The AIClient — used to fetch exact cost from the gateway post-hoc. */
  aiClient: AIClient;
  /** Generation ID captured from the stream's finish event. */
  generationId: string;
  /** The user's input message. */
  inputContent: string;
  /** The AI's response. */
  outputContent: string;
}

/**
 * Calculate the final billable cost for a message.
 *
 * SINGLE PATH: queries the AI gateway's getGenerationStats for the exact USD cost,
 * then applies HushBox fees and storage cost. The gateway's totalCost includes
 * any web search calls, caching discounts, and tiered pricing.
 *
 * If getGenerationStats fails, this function throws — there is no silent
 * estimation fallback. Pre-inference budget reservation uses estimation
 * (a separate concern in @hushbox/shared/pricing).
 */
export async function calculateMessageCost(params: CalculateMessageCostParams): Promise<number> {
  const { aiClient, generationId, inputContent, outputContent } = params;

  const { costUsd } = await aiClient.getGenerationStats(generationId);

  return calculateMessageCostFromActual({
    gatewayCost: costUsd,
    inputCharacters: inputContent.length,
    outputCharacters: outputContent.length,
  });
}
