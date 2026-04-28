import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  MEDIA_STORAGE_COST_PER_BYTE,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
} from './constants.js';
import type { UserTier } from './tiers.js';

/**
 * Parse a price string from the AI Gateway model metadata. Works for any
 * price field — per-token, per-image, or per-second — despite the historical
 * name. Returns 0 for negative sentinel values (e.g. "-1" = "variable pricing")
 * and for NaN/missing values.
 */
export function parseTokenPrice(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) || value < 0 ? 0 : value;
}

/**
 * Estimate token count from text using character-based heuristic.
 * Uses ~4 characters per token approximation.
 * This is an approximation - actual tokenization varies by model.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Apply all fees (HushBox + CC + Provider) to a base price.
 * SINGLE SOURCE OF TRUTH for fee application.
 *
 * Used by:
 * - Model selector to show per-token pricing with fees
 * - calculateTokenCostWithFees as building block
 *
 * Fee breakdown (15% total):
 * - 5% HushBox profit margin
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
  /** Tokens used for input (from the AI Gateway) */
  inputTokens: number;
  /** Tokens used for output (from the AI Gateway) */
  outputTokens: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
  /** Model's price per input token in USD */
  pricePerInputToken: number;
  /** Model's price per output token in USD */
  pricePerOutputToken: number;
  /** Per-search cost in USD (base price, fees will be applied). 0 or omitted if no search. */
  webSearchCost?: number;
}

/**
 * Estimate message cost for development environment using token counts.
 *
 * Use this when exact AI Gateway generation stats are not available (local development).
 * For production, use calculateMessageCostFromActual with exact costs.
 *
 * Components:
 * 1. Token cost with fees: uses calculateTokenCostWithFees (includes 15% markup)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 *
 * Storage fee applies only to new messages (input + output), not conversation history.
 * Fees (15%) apply only to model cost, not to storage fee.
 */
export function estimateMessageCostDevelopment(params: MessageCostParams): number {
  const {
    inputTokens,
    outputTokens,
    inputCharacters,
    outputCharacters,
    pricePerInputToken,
    pricePerOutputToken,
    webSearchCost = 0,
  } = params;

  const tokenCostWithFees = calculateTokenCostWithFees(
    inputTokens,
    outputTokens,
    pricePerInputToken,
    pricePerOutputToken
  );

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return tokenCostWithFees + storageFee + applyFees(webSearchCost);
}

export interface MessageCostFromActualParams {
  /** Exact cost in USD from the AI gateway's getGenerationInfo endpoint */
  gatewayCost: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
}

/**
 * Calculate message cost using the AI gateway's exact cost.
 * SINGLE SOURCE OF TRUTH for billing based on actual usage.
 *
 * The gateway's totalCost includes any web search tool calls, caching discounts,
 * and tiered pricing. This function adds HushBox fees and storage cost on top.
 *
 * Components:
 * 1. Model cost with fees: gatewayCost × (1 + TOTAL_FEE_RATE)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 */
export function calculateMessageCostFromActual(params: MessageCostFromActualParams): number {
  const { gatewayCost, inputCharacters, outputCharacters } = params;

  const modelCostWithFees = applyFees(gatewayCost);

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return modelCostWithFees + storageFee;
}

/**
 * Get combined model cost per 1k tokens with fees applied.
 * SINGLE SOURCE OF TRUTH for model cost comparison.
 *
 * Used by:
 * - Model selector for sorting
 * - isExpensiveModel() check
 * - Any UI showing combined model cost
 *
 * @param pricePerInputToken - Model's price per input token in USD
 * @param pricePerOutputToken - Model's price per output token in USD
 * @returns Combined cost per 1k tokens with fees applied
 */
export function getModelCostPer1k(pricePerInputToken: number, pricePerOutputToken: number): number {
  const baseCostPer1k = (pricePerInputToken + pricePerOutputToken) * 1000;
  return applyFees(baseCostPer1k);
}

/**
 * Check if a model is considered expensive (>= threshold per 1k tokens with fees).
 *
 * @param pricePerInputToken - Model's price per input token in USD
 * @param pricePerOutputToken - Model's price per output token in USD
 * @returns true if model cost per 1k >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
 */
export function isExpensiveModel(pricePerInputToken: number, pricePerOutputToken: number): boolean {
  return (
    getModelCostPer1k(pricePerInputToken, pricePerOutputToken) >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
  );
}

/**
 * Compute fee-inclusive model pricing from raw per-token prices.
 * SINGLE SOURCE OF TRUTH for extracting model pricing with fees applied.
 *
 * Accepts raw (pre-fee) prices — callers parse strings or pass numbers directly.
 * Returns fee-inclusive prices ready for budget calculation.
 */
export interface ModelPricingResult {
  inputPricePerToken: number;
  outputPricePerToken: number;
  contextLength: number;
}

export function getModelPricing(
  inputPricePerToken: number,
  outputPricePerToken: number,
  contextLength: number
): ModelPricingResult {
  return {
    inputPricePerToken: applyFees(inputPricePerToken),
    outputPricePerToken: applyFees(outputPricePerToken),
    contextLength,
  };
}

/**
 * Effective cost per output token: model cost + estimated storage cost.
 *
 * Output is tokens→chars: INVERTED from input (chars→tokens).
 * Free/trial/guest: STANDARD (4 chars/tok) → pessimistic (more storage budgeted).
 * Paid: CONSERVATIVE (2 chars/tok) → optimistic (less storage, cushion absorbs overruns).
 */
export function effectiveOutputCostPerToken(
  modelOutputPricePerToken: number,
  tier: UserTier
): number {
  const outputCharsPerToken =
    tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
  const storageCostPerToken = outputCharsPerToken * STORAGE_COST_PER_CHARACTER;
  return modelOutputPricePerToken + storageCostPerToken;
}

/**
 * Storage cost for media bytes (R2 + backup, 50-year retention).
 * Used by both pre-inference budget reservation and post-inference billing.
 */
export function mediaStorageCost(sizeBytes: number): number {
  return sizeBytes * MEDIA_STORAGE_COST_PER_BYTE;
}

export type MediaPricing =
  | { kind: 'image'; perImage: number }
  | { kind: 'audio'; perSecond: number }
  | { kind: 'video'; perSecond: number };

export interface CalculateMediaGenerationCostParams {
  pricing: MediaPricing;
  sizeBytes: number;
  imageCount?: number;
  durationSeconds?: number;
}

/**
 * Calculate the final billable cost for a media generation.
 * Deterministic — no gateway call needed. Fees apply to model cost;
 * storage cost is additive (no fee on storage).
 */
export function calculateMediaGenerationCost(params: CalculateMediaGenerationCostParams): number {
  const { pricing, sizeBytes, imageCount, durationSeconds } = params;
  const storage = mediaStorageCost(sizeBytes);

  switch (pricing.kind) {
    case 'image': {
      const count = imageCount ?? 1;
      return applyFees(pricing.perImage * count) + storage;
    }
    case 'video': {
      if (durationSeconds === undefined)
        throw new Error('durationSeconds required for video pricing');
      return applyFees(pricing.perSecond * durationSeconds) + storage;
    }
    case 'audio': {
      if (durationSeconds === undefined)
        throw new Error('durationSeconds required for audio pricing');
      return applyFees(pricing.perSecond * durationSeconds) + storage;
    }
  }
}

/**
 * Pre-inference worst-case cost for image generation in cents.
 * Uses ESTIMATED_IMAGE_BYTES as the storage estimate; actual cost is
 * recomputed post-inference with the real R2 object size.
 */
export function computeImageWorstCaseCents(perImage: number, modelCount: number): number {
  if (modelCount === 0) return 0;
  const perModel = applyFees(perImage) + mediaStorageCost(ESTIMATED_IMAGE_BYTES);
  return perModel * modelCount * 100;
}

export interface EstimateVideoWorstCaseCentsInput {
  perSecond: number;
  durationSeconds: number;
  modelCount: number;
}

/**
 * Pre-inference worst-case cost for video generation in cents.
 * Uses `durationSeconds × ESTIMATED_VIDEO_BYTES_PER_SECOND` as the storage
 * estimate; actual cost is recomputed post-inference with the real R2 size.
 */
export function estimateVideoWorstCaseCents(input: EstimateVideoWorstCaseCentsInput): number {
  const { perSecond, durationSeconds, modelCount } = input;
  if (durationSeconds === 0 || modelCount === 0) return 0;
  const estimatedBytes = durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND;
  const perModel = applyFees(perSecond * durationSeconds) + mediaStorageCost(estimatedBytes);
  return perModel * modelCount * 100;
}

/**
 * Exact pre-inference cost for image generation in cents, given the actual
 * per-image price of each selected model. Image pricing is deterministic at
 * reservation time, so there's no need for a worst-case estimate — we sum
 * the real prices, apply fees once to the sum, and add per-model storage.
 */
export function computeImageExactCents(pricesPerImage: readonly number[]): number {
  if (pricesPerImage.length === 0) return 0;
  const sumModelCost = pricesPerImage.reduce((s, p) => s + p, 0);
  const storage = mediaStorageCost(ESTIMATED_IMAGE_BYTES) * pricesPerImage.length;
  return (applyFees(sumModelCost) + storage) * 100;
}

/**
 * Exact pre-inference cost for video generation in cents, given each selected
 * model's `perSecond` price at the requested resolution and the user's chosen
 * duration. Like image, video pricing is deterministic at reservation time,
 * so this replaces the worst-case formula for multi-model billing.
 */
export function computeVideoExactCents(
  pricesPerSecond: readonly number[],
  durationSeconds: number
): number {
  if (pricesPerSecond.length === 0 || durationSeconds === 0) return 0;
  const sumModelCost = pricesPerSecond.reduce((s, p) => s + p * durationSeconds, 0);
  const estimatedBytes = durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND;
  const storage = mediaStorageCost(estimatedBytes) * pricesPerSecond.length;
  return (applyFees(sumModelCost) + storage) * 100;
}

/**
 * Worst-case pre-inference cost for audio (TTS) generation in cents. Unlike
 * image and video — where the count or duration is fixed in the request — TTS
 * output length emerges from the synthesis, so we reserve against the user's
 * `maxDurationSeconds` cap and rebill at the actual generated `durationMs`.
 *
 * Same shape as `computeVideoExactCents`: sum per-model (perSecond × maxDuration),
 * apply fees once, add per-model storage. The "WorstCase" suffix mirrors text's
 * `computeWorstCaseCents` (both reserve against an upper bound that the actual
 * output usually undershoots).
 */
export function computeAudioWorstCaseCents(
  pricesPerSecond: readonly number[],
  maxDurationSeconds: number
): number {
  if (pricesPerSecond.length === 0 || maxDurationSeconds === 0) return 0;
  const sumModelCost = pricesPerSecond.reduce((s, p) => s + p * maxDurationSeconds, 0);
  const estimatedBytes = maxDurationSeconds * ESTIMATED_AUDIO_BYTES_PER_SECOND;
  const storage = mediaStorageCost(estimatedBytes) * pricesPerSecond.length;
  return (applyFees(sumModelCost) + storage) * 100;
}
