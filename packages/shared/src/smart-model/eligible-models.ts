import {
  STORAGE_COST_PER_CHARACTER,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
} from '../constants.js';
import { canAffordModel, estimateTokensForTier, getEffectiveBalance } from '../budget.js';
import { applyFees } from '../pricing.js';
import { computeClassifierPromptOverhead } from './prompts.js';
import { MAX_CLASSIFIER_CONTEXT_CHARS } from './truncate.js';
import type { Model } from '../schemas/api/models.js';
import type { UserTier } from '../tiers.js';

/**
 * Hard cap on classifier output tokens. The classifier should emit a single
 * model id (~10–30 tokens). 50 leaves slack for stop-token quirks while
 * tightly bounding worst-case spend on the routing call itself.
 */
export const CLASSIFIER_OUTPUT_TOKEN_CAP = 50;

/**
 * Legacy fallback constant. Retained as a backstop for paths that still need
 * a numeric estimate without a model list in hand. New code should call
 * {@link computeMaxClassifierOverhead} or {@link computeClassifierPromptOverhead}
 * to get the EXACT prompt overhead for a known eligible set — the constant
 * was a guess (5000 ≈ 30 entries × ~150 chars) that drifts from the prompt
 * template every time the wording or model list size changes.
 */
export const CLASSIFIER_PROMPT_OVERHEAD_CHARS = 5000;

/**
 * Compute the EXACT classifier-prompt overhead in characters for the supplied
 * model list. Approach A from the lane-4 brief: render the prompt template
 * against the actual eligible models (with Smart-Model entries skipped) and
 * count the rendered chars. The result equals the system prompt + user-side
 * wrapping when truncated context is empty — i.e. the worst-case overhead
 * before adding {@link MAX_CLASSIFIER_CONTEXT_CHARS} of context.
 *
 * Pure function — no caching needed; the input list is small (~tens of
 * entries) and callers run this once per Smart Model invocation.
 */
export function computeMaxClassifierOverhead(models: readonly Model[]): number {
  const eligibleForPrompt = models
    .filter((m) => m.isSmartModel !== true)
    .map((m) => ({ id: m.id, description: m.description }));
  return computeClassifierPromptOverhead(eligibleForPrompt);
}

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
 *
 * `overheadChars` is computed from the ACTUAL prompt template via
 * {@link computeMaxClassifierOverhead} so the estimate updates automatically
 * if the prompt template grows, instead of drifting from a fixed constant.
 */
function computeClassifierWorstCaseCents(
  classifier: RealCandidate,
  tier: UserTier,
  overheadChars: number
): number {
  const inputChars = MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars;
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
  // Worst-case overhead uses the FULL textModels list (Smart Model entries
  // skipped inside `computeMaxClassifierOverhead`) — once a budget tightens
  // and shrinks the eligible set, the prompt the classifier actually sees is
  // smaller, so this is an upper bound that's safe for budgeting.
  const overheadChars = computeMaxClassifierOverhead(input.textModels);
  const classifierWorstCaseCents = computeClassifierWorstCaseCents(
    classifier,
    input.payerTier,
    overheadChars
  );

  const affordable = findAffordableCandidates(candidates, classifierWorstCaseCents, input);
  if (affordable.length === 0) return null;

  return {
    classifierModelId: classifier.id,
    eligibleInferenceIds: affordable.map((c) => c.id),
    classifierWorstCaseCents,
  };
}
