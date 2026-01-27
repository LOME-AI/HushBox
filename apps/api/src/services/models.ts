/**
 * Model processing service.
 *
 * Handles filtering, classification, and transformation of OpenRouter models.
 */

import type { Model, ModelCapability } from '@lome-chat/shared';

import { isPremiumModel, PREMIUM_PRICE_PERCENTILE } from './models/premium-check.js';

// ============================================================
// Constants
// ============================================================

/** Percentile threshold for top context (0.95 = top 5%) */
const TOP_CONTEXT_PERCENTILE = 0.95;

/** Maximum age for models (2 years in milliseconds) */
const MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Minimum combined price per 1K tokens ($0.001) */
const MIN_PRICE_PER_1K_TOKENS = 0.001;

/** Name patterns for utility models that should always be excluded */
const EXCLUDED_NAME_PATTERNS = [/body builder/i, /auto router/i, /audio/i, /image/i];

/** Provider name mapping from model ID prefix */
const PROVIDER_MAP: Record<string, string> = {
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
// Types
// ============================================================

/** Raw model data from OpenRouter API */
export interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters: string[];
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

/** Result of processing models */
export interface ProcessedModels {
  models: Model[];
  premiumIds: string[];
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Get the combined price of a model (prompt + completion per token).
 */
function getCombinedPrice(model: OpenRouterModel): number {
  return Number.parseFloat(model.pricing.prompt) + Number.parseFloat(model.pricing.completion);
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
 * - Minimum price: cheaper than $0.001 per 1K tokens
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
  const match = /^([^:]+):\s*(.+)$/.exec(model.name);
  if (match?.[1] && match[2]) {
    return { provider: match[1].trim(), displayName: match[2].trim() };
  }

  const prefix = model.id.split('/')[0] ?? '';
  return { provider: PROVIDER_MAP[prefix] ?? 'Unknown', displayName: model.name };
}

/**
 * Derive capabilities from supported_parameters.
 * - 'tools' or 'tool_choice' → functions
 * - 'response_format' → json-mode
 * - All models support streaming by default
 */
function deriveCapabilities(params: string[]): ModelCapability[] {
  const caps: ModelCapability[] = ['streaming'];

  if (params.includes('tools') || params.includes('tool_choice')) {
    caps.push('functions');
  }

  if (params.includes('response_format')) {
    caps.push('json-mode');
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
    pricePerInputToken: Number.parseFloat(model.pricing.prompt),
    pricePerOutputToken: Number.parseFloat(model.pricing.completion),
    capabilities: deriveCapabilities(model.supported_parameters),
    supportedParameters: model.supported_parameters,
    created: model.created,
  };
}

// ============================================================
// Main exports
// ============================================================

/**
 * Transform a single OpenRouter model to the shared Model type.
 */
export function transformModel(model: OpenRouterModel): Model {
  return transform(model);
}

/**
 * Process raw OpenRouter models: filter, classify, and transform.
 *
 * Filtering rules:
 * - Always excluded: free models, utility models (body builder, auto router, image)
 * - Standard exclusion (bypassed by top 5% context): age > 2 years, price < $0.001/1K tokens
 *
 * Premium classification:
 * - Price >= 75th percentile of filtered models, OR
 * - Released within the last year
 */
export function processModels(rawModels: OpenRouterModel[]): ProcessedModels {
  // Calculate context threshold from full list (needed for filtering decision)
  const contexts = rawModels.map((m) => m.context_length);
  const contextThreshold = calculatePercentileThreshold(contexts, TOP_CONTEXT_PERCENTILE);

  // Filter
  const filtered = rawModels.filter((model) => {
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
  const models: Model[] = [];
  const premiumIds: string[] = [];

  for (const model of filtered) {
    models.push(transform(model));
    if (isPremiumModel(model, priceThreshold)) {
      premiumIds.push(model.id);
    }
  }

  return { models, premiumIds };
}
