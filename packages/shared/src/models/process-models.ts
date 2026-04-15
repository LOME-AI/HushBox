/**
 * Model processing service.
 *
 * Handles filtering, classification, and transformation of OpenRouter models.
 */

import type { Model, ModelCapability } from '../schemas/api/models.js';
import {
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_INPUT_PRICE_PER_TOKEN,
  AUTO_ROUTER_OUTPUT_PRICE_PER_TOKEN,
} from '../constants.js';
import { parseTokenPrice } from '../pricing.js';

import { buildSystemPrompt } from '../prompt/build-system-prompt.js';

import { isPremiumModel, PREMIUM_PRICE_PERCENTILE, exceedsTrialBudget } from './premium-check.js';
import { isZdrModel } from './zdr.js';

import type { OpenRouterModel, ProcessedModels } from './types.js';

// ============================================================
// Constants
// ============================================================

/** Percentile threshold for top context (0.95 = top 5%) */
const TOP_CONTEXT_PERCENTILE = 0.95;

/** Maximum age for models (2 years in milliseconds) */
const MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Minimum combined price per 1K tokens ($0.0002) */
const MIN_PRICE_PER_1K_TOKENS = 0.0002;

/** Name patterns for utility models that should always be excluded */
const EXCLUDED_NAME_PATTERNS = [/body builder/i, /auto router/i, /audio/i, /image/i];

/** Provider name mapping from model ID prefix */
export const PROVIDER_MAP: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'meta-llama': 'Meta',
  mistral: 'Mistral',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
};

// ============================================================
// Internal helpers
// ============================================================

/**
 * Get the combined price of a model (prompt + completion per token).
 */
function getCombinedPrice(model: OpenRouterModel): number {
  return parseTokenPrice(model.pricing.prompt) + parseTokenPrice(model.pricing.completion);
}

/**
 * Calculate the threshold at the given percentile.
 */
function calculatePercentileThreshold(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.floor(sorted.length * percentile);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

/**
 * Check if model should always be excluded (never bypassed by top context).
 * - Free models (both prices = 0)
 * - Utility models by name pattern
 * - Models that don't include text in input or output modalities
 */
function isExcludedAlways(model: OpenRouterModel): boolean {
  if (getCombinedPrice(model) === 0) {
    return true;
  }
  if (EXCLUDED_NAME_PATTERNS.some((p) => p.test(model.name))) {
    return true;
  }
  const hasTextInput = model.architecture.input_modalities.includes('text');
  const hasTextOutput = model.architecture.output_modalities.includes('text');
  return !hasTextInput || !hasTextOutput;
}

/**
 * Check if model should be excluded by standard criteria.
 * These can be bypassed by top context models.
 * - Age: older than 2 years
 * - Minimum price: cheaper than $0.0002 per 1K tokens
 */
function isExcludedByStandardCriteria(model: OpenRouterModel): boolean {
  const cutoffMs = Date.now() - MAX_AGE_MS;
  if (model.created * 1000 < cutoffMs) {
    return true;
  }

  const pricePer1K = getCombinedPrice(model) * 1000;
  return pricePer1K < MIN_PRICE_PER_1K_TOKENS;
}

/**
 * Extract provider and clean name from model.
 * Tries "Provider: Model Name" format first, falls back to ID prefix.
 */
function extractProvider(model: OpenRouterModel): { provider: string; displayName: string } {
  const colonIndex = model.name.indexOf(':');
  if (colonIndex > 0) {
    const provider = model.name.slice(0, colonIndex).trim();
    const displayName = model.name.slice(colonIndex + 1).trim();
    if (provider && displayName) {
      return { provider, displayName };
    }
  }

  const prefix = model.id.split('/')[0] ?? '';
  return { provider: PROVIDER_MAP[prefix] ?? 'Unknown', displayName: model.name };
}

/**
 * Derive capabilities from supported_parameters.
 * Only 'internet-search' is currently tracked — detected via 'web_search_options'.
 */
function deriveCapabilities(params: string[]): ModelCapability[] {
  const caps: ModelCapability[] = [];

  if (params.includes('web_search_options')) {
    caps.push('internet-search');
  }

  return caps;
}

/**
 * Transform OpenRouter model to shared Model type.
 */
function transform(model: OpenRouterModel): Model {
  const { provider, displayName } = extractProvider(model);
  return {
    id: model.id,
    name: displayName,
    description: model.description,
    provider,
    contextLength: model.context_length,
    pricePerInputToken: parseTokenPrice(model.pricing.prompt),
    pricePerOutputToken: parseTokenPrice(model.pricing.completion),
    capabilities: deriveCapabilities(model.supported_parameters),
    supportedParameters: model.supported_parameters,
    webSearchPrice: model.pricing.web_search
      ? Number.parseFloat(model.pricing.web_search) || undefined
      : undefined,
    created: model.created,
  };
}

// ============================================================
// Main exports
// ============================================================

/**
 * Process raw OpenRouter models: filter, classify, and transform.
 *
 * Filtering rules:
 * - Always excluded: free models, utility models (body builder, auto router, image)
 * - Standard exclusion (bypassed by top 5% context): age > 2 years, price < $0.0002/1K tokens
 *
 * Premium classification:
 * - Price >= 75th percentile of filtered models, OR
 * - Released within the last year, OR
 * - Output cost exceeds trial budget for 2× minimum output tokens
 */
/**
 * Build auto-router Model entry with price ranges derived from the model pool.
 */
function buildAutoRouterModel(autoRouterRaw: OpenRouterModel, pool: OpenRouterModel[]): Model {
  const inputPrices = pool.map((m) => parseTokenPrice(m.pricing.prompt));
  const outputPrices = pool.map((m) => parseTokenPrice(m.pricing.completion));

  return {
    id: AUTO_ROUTER_MODEL_ID,
    name: 'Smart Model',
    description: autoRouterRaw.description,
    provider: 'OpenRouter',
    contextLength: autoRouterRaw.context_length,
    pricePerInputToken: AUTO_ROUTER_INPUT_PRICE_PER_TOKEN,
    pricePerOutputToken: AUTO_ROUTER_OUTPUT_PRICE_PER_TOKEN,
    capabilities: deriveCapabilities(autoRouterRaw.supported_parameters),
    supportedParameters: autoRouterRaw.supported_parameters,
    isAutoRouter: true,
    minPricePerInputToken: Math.min(...inputPrices),
    minPricePerOutputToken: Math.min(...outputPrices),
    maxPricePerInputToken: Math.max(...inputPrices),
    maxPricePerOutputToken: Math.max(...outputPrices),
  };
}

export function processModels(rawModels: OpenRouterModel[]): ProcessedModels {
  // ZDR filter: only include models on the per-modality ZDR allow-list.
  // For now, process-models handles text only; image/video use their own paths.
  const zdrFiltered = rawModels.filter((m) => isZdrModel(m.id, 'text'));

  // Extract auto-router from full list (it enforces ZDR via provider config, so it
  // doesn't need to appear in the /endpoints/zdr response)
  const autoRouterRaw = rawModels.find((m) => m.id === AUTO_ROUTER_MODEL_ID);
  const modelsForFiltering = zdrFiltered.filter((m) => m.id !== AUTO_ROUTER_MODEL_ID);

  // Calculate context threshold from non-auto-router models
  const contexts = modelsForFiltering.map((m) => m.context_length);
  const contextThreshold = calculatePercentileThreshold(contexts, TOP_CONTEXT_PERCENTILE);

  // Filter
  const filtered = modelsForFiltering.filter((model) => {
    if (isExcludedAlways(model)) {
      return false;
    }
    if (model.context_length >= contextThreshold) {
      return true; // Top context bypasses standard criteria
    }
    return !isExcludedByStandardCriteria(model);
  });

  // Calculate price threshold from filtered list (reflects available models)
  const prices = filtered.map((model) => getCombinedPrice(model));
  const priceThreshold = calculatePercentileThreshold(prices, PREMIUM_PRICE_PERCENTILE);

  // Classify and transform
  const systemPromptChars = buildSystemPrompt([]).length;
  const models: Model[] = [];
  const premiumIds: string[] = [];

  for (const model of filtered) {
    models.push(transform(model));
    if (isPremiumModel(model, priceThreshold) || exceedsTrialBudget(model, systemPromptChars)) {
      premiumIds.push(model.id);
    }
  }

  // Inject auto-router if present in ZDR list and pool has models
  if (autoRouterRaw && filtered.length > 0) {
    models.push(buildAutoRouterModel(autoRouterRaw, filtered));
  }

  return { models, premiumIds };
}
