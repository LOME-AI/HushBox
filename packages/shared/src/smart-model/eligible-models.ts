import {
  STORAGE_COST_PER_CHARACTER,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
} from '../constants.js';
import { canAffordModel, estimateTokensForTier, getEffectiveBalance } from '../budget.js';
import { applyFees } from '../pricing.js';
import type { Model } from '../schemas/api/models.js';
import type { UserTier } from '../tiers.js';

import { MAX_CLASSIFIER_CONTEXT_CHARS } from './truncate.js';

/**
 * Hard cap on classifier output tokens. The classifier should emit a single
 * model id (~10–30 tokens). 50 leaves slack for stop-token quirks while
 * tightly bounding worst-case spend on the routing call itself.
 */
export const CLASSIFIER_OUTPUT_TOKEN_CAP = 50;

/**
 * Conservative overhead added to {@link MAX_CLASSIFIER_CONTEXT_CHARS} when
 * estimating the classifier prompt size. Covers the system prompt template
 * plus a long-tail model list (≈30 entries × ~150 chars per entry).
 */
export const CLASSIFIER_PROMPT_OVERHEAD_CHARS = 5000;

export interface EligibleModelsInput {
  /** Text models from `processModels(...).models` (raw prices, no fees applied). */
  textModels: readonly Model[];
  /** Premium ids that require paid tier (from `processModels(...).premiumIds`). */
  premiumIds: ReadonlySet<string>;
  payerTier: UserTier;
  payerBalanceCents: number;
  payerFreeAllowanceCents: number;
  /** Total characters in the prompt that the inference call will receive. */
  promptCharacterCount: number;
}

export interface EligibleModelsResult {
  /** Cheapest eligible model — used to make the classifier call itself. */
  classifierModelId: string;
  /** Models the classifier may pick from. Always includes the classifier model. */
  eligibleInferenceIds: readonly string[];
  /** Worst-case classifier call cost in cents (with fees), used for budget reservation. */
  classifierWorstCaseCents: number;
}

interface RealCandidate {
  id: string;
  pricePerInputToken: number;
  pricePerOutputToken: number;
  combinedPrice: number;
  isPremium: boolean;
}

function combinedPrice(model: Model): number {
  return model.pricePerInputToken + model.pricePerOutputToken;
}

function filterAndSortCandidates(input: EligibleModelsInput): RealCandidate[] {
  const canAccessPremium = input.payerTier === 'paid';
  const candidates: RealCandidate[] = [];

  for (const model of input.textModels) {
    if (model.isSmartModel) continue;
    const isPremium = input.premiumIds.has(model.id);
    if (isPremium && !canAccessPremium) continue;

    candidates.push({
      id: model.id,
      pricePerInputToken: model.pricePerInputToken,
      pricePerOutputToken: model.pricePerOutputToken,
      combinedPrice: combinedPrice(model),
      isPremium,
    });
  }

  candidates.sort((a, b) => a.combinedPrice - b.combinedPrice);
  return candidates;
}

/**
 * Conservative classifier-cost worst-case in cents (fees applied).
 *
 * Treats the prompt as the largest plausible classifier call: full
 * conversation truncation budget plus system prompt and model list overhead.
 * Uses {@link CLASSIFIER_OUTPUT_TOKEN_CAP} as the output ceiling.
 */
function computeClassifierWorstCaseCents(classifier: RealCandidate, tier: UserTier): number {
  const inputChars = MAX_CLASSIFIER_CONTEXT_CHARS + CLASSIFIER_PROMPT_OVERHEAD_CHARS;
  const inputTokens = estimateTokensForTier(tier, inputChars);
  // Output storage chars-per-token is tier-inverted (matches buildCostManifest).
  const outputCharsPerToken =
    tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;

  const inputCostUsd =
    applyFees(inputTokens * classifier.pricePerInputToken) +
    inputChars * STORAGE_COST_PER_CHARACTER;
  const outputCostUsd =
    applyFees(CLASSIFIER_OUTPUT_TOKEN_CAP * classifier.pricePerOutputToken) +
    CLASSIFIER_OUTPUT_TOKEN_CAP * outputCharsPerToken * STORAGE_COST_PER_CHARACTER;

  return (inputCostUsd + outputCostUsd) * 100;
}

function findAffordableCandidates(
  candidates: readonly RealCandidate[],
  classifierWorstCaseCents: number,
  input: EligibleModelsInput
): RealCandidate[] {
  const effectiveBalanceCents =
    getEffectiveBalance(input.payerTier, input.payerBalanceCents, input.payerFreeAllowanceCents) *
    100;

  const effectiveAfterClassifier = effectiveBalanceCents - classifierWorstCaseCents;
  if (effectiveAfterClassifier <= 0) return [];

  const affordable: RealCandidate[] = [];
  for (const candidate of candidates) {
    const result = canAffordModel({
      tier: input.payerTier,
      balanceCents: input.payerBalanceCents,
      freeAllowanceCents: input.payerFreeAllowanceCents,
      promptCharacterCount: input.promptCharacterCount,
      modelInputPricePerToken: applyFees(candidate.pricePerInputToken),
      modelOutputPricePerToken: applyFees(candidate.pricePerOutputToken),
      isPremium: candidate.isPremium,
    });
    if (!result.affordable) continue;
    const minCostCents = result.estimatedMinimumCost * 100;
    if (minCostCents + classifierWorstCaseCents <= effectiveBalanceCents) {
      affordable.push(candidate);
    }
  }
  return affordable;
}

/**
 * Build the classifier model id and the eligible-inference set for a Smart
 * Model invocation. Returns `null` when the user can't afford any model after
 * accounting for classifier overhead.
 *
 * The classifier is always the cheapest affordable text model accessible to
 * the payer's tier; the eligible set is every model whose worst-case
 * inference cost plus the classifier overhead fits the user's effective
 * balance.
 *
 * Pure function — single source of truth for "what can this user route to?".
 */
export function buildEligibleModels(input: EligibleModelsInput): EligibleModelsResult | null {
  const candidates = filterAndSortCandidates(input);
  if (candidates.length === 0) return null;

  const classifier = candidates[0];
  if (classifier === undefined) return null;
  const classifierWorstCaseCents = computeClassifierWorstCaseCents(classifier, input.payerTier);

  const affordable = findAffordableCandidates(candidates, classifierWorstCaseCents, input);
  if (affordable.length === 0) return null;

  return {
    classifierModelId: classifier.id,
    eligibleInferenceIds: affordable.map((c) => c.id),
    classifierWorstCaseCents,
  };
}
