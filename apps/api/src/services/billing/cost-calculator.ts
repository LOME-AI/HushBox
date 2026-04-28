import {
  applyFees,
  calculateMessageCostFromActual,
  type PreInferenceBilling,
} from '@hushbox/shared';
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

export interface CalculateMessageCostWithStagesParams {
  aiClient: AIClient;
  /** Generation id from the main inference's finish event. */
  mainGenerationId: string;
  /** Pre-inference stage billings — each one will produce its own usage_records row. */
  stageBillings: readonly PreInferenceBilling[];
  /** The user's input message (for storage cost). */
  inputContent: string;
  /** The AI's response (for storage cost). */
  outputContent: string;
}

export interface StageCostAttribution {
  billing: PreInferenceBilling;
  /** Pre-fee gateway USD cost from getGenerationStats. */
  gatewayCostUsd: number;
  /** Cost in dollars attributable to this stage (gateway cost × fee multiplier). */
  costDollars: number;
}

export interface CalculateMessageCostWithStagesResult {
  /** Total cost in dollars to denormalize into `content_items.cost`. */
  totalDollars: number;
  /** Cost attributable to the main inference call (with fees and storage). */
  mainCostDollars: number;
  /** Per-stage cost breakdown for the additional `usage_records` rows. */
  stageBreakdown: StageCostAttribution[];
}

/**
 * Calculate the final billable cost for a message that ran one or more
 * pre-inference stages (e.g., Smart Model classifier) ahead of the main
 * inference call.
 *
 * Each stage and the main inference produce separate `usage_records` rows
 * with their own model id and generationId. The breakdown returned here
 * gives the per-row dollar attribution; `totalDollars` is the sum and
 * matches what the UI displays as the message's total cost.
 *
 * Storage cost is attributed entirely to the main inference (the user's
 * message and the AI's response are what's persisted; stage prompts and
 * outputs are ephemeral). Fees apply to every gateway cost identically,
 * so the additive property holds:
 *   totalDollars === mainCostDollars + Σ stageBreakdown.costDollars
 *
 * Errors from any getGenerationStats call propagate — no silent fallback.
 */
export async function calculateMessageCostWithStages(
  params: CalculateMessageCostWithStagesParams
): Promise<CalculateMessageCostWithStagesResult> {
  const { aiClient, mainGenerationId, stageBillings, inputContent, outputContent } = params;

  const [mainStats, ...stageStats] = await Promise.all([
    aiClient.getGenerationStats(mainGenerationId),
    ...stageBillings.map((b) => aiClient.getGenerationStats(b.generationId)),
  ]);

  const stageBreakdown: StageCostAttribution[] = stageBillings.map((billing, index) => {
    const stats = stageStats[index];
    const gatewayCostUsd = stats?.costUsd ?? 0;
    return {
      billing,
      gatewayCostUsd,
      costDollars: applyFees(gatewayCostUsd),
    };
  });

  const stageGatewayUsd = stageBreakdown.reduce((sum, b) => sum + b.gatewayCostUsd, 0);
  const totalDollars = calculateMessageCostFromActual({
    gatewayCost: mainStats.costUsd + stageGatewayUsd,
    inputCharacters: inputContent.length,
    outputCharacters: outputContent.length,
  });
  const stageDollarsSum = stageBreakdown.reduce((sum, b) => sum + b.costDollars, 0);
  const mainCostDollars = totalDollars - stageDollarsSum;

  return { totalDollars, mainCostDollars, stageBreakdown };
}
