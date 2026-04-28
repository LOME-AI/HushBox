/**
 * Model processing service.
 *
 * Handles filtering, classification, and transformation of AI Gateway models.
 */

import type { Model, ModelCapability } from '../schemas/api/models.js';
import {
  SMART_MODEL_ID,
  SMART_MODEL_INPUT_PRICE_PER_TOKEN,
  SMART_MODEL_OUTPUT_PRICE_PER_TOKEN,
} from '../constants.js';
import { parseTokenPrice } from '../pricing.js';

import { buildSystemPrompt } from '../prompt/build-system-prompt.js';

import { isPremiumModel, PREMIUM_PRICE_PERCENTILE, exceedsTrialBudget } from './premium-check.js';
import { isZdrModel } from './zdr.js';

import type { Modality, RawModel, ProcessedModels } from './types.js';

// ============================================================
// Constants
// ============================================================

/** Percentile threshold for top context (0.95 = top 5%) */
const TOP_CONTEXT_PERCENTILE = 0.95;

/** Maximum age for models (2 years in milliseconds) */
const MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Minimum combined price per 1K tokens ($0.0002) */
const MIN_PRICE_PER_1K_TOKENS = 0.0002;

/** Name patterns for text-utility models that should always be excluded. */
const EXCLUDED_TEXT_NAME_PATTERNS = [/body builder/i, /auto router/i, /audio/i, /image/i];

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
// Shared helpers
// ============================================================

function getCombinedPrice(model: RawModel): number {
  return parseTokenPrice(model.pricing.prompt) + parseTokenPrice(model.pricing.completion);
}

function calculatePercentileThreshold(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.floor(sorted.length * percentile);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function extractProvider(model: RawModel): { provider: string; displayName: string } {
  const colonIndex = model.name.indexOf(':');
  if (colonIndex > 0) {
    const provider = model.name.slice(0, colonIndex).trim();
    const displayName = model.name.slice(colonIndex + 1).trim();
    if (provider && displayName) return { provider, displayName };
  }
  const prefix = model.id.split('/')[0] ?? '';
  return { provider: PROVIDER_MAP[prefix] ?? 'Unknown', displayName: model.name };
}

function deriveCapabilities(params: string[]): ModelCapability[] {
  const caps: ModelCapability[] = [];
  if (params.includes('web_search_options')) caps.push('internet-search');
  return caps;
}

// ============================================================
// Text processing (existing logic preserved)
// ============================================================

function isExcludedAlways(model: RawModel): boolean {
  if (getCombinedPrice(model) === 0) return true;
  if (EXCLUDED_TEXT_NAME_PATTERNS.some((p) => p.test(model.name))) return true;
  const hasTextInput = model.architecture.input_modalities.includes('text');
  const hasTextOutput = model.architecture.output_modalities.includes('text');
  return !hasTextInput || !hasTextOutput;
}

function isExcludedByStandardCriteria(model: RawModel): boolean {
  const cutoffMs = Date.now() - MAX_AGE_MS;
  if (model.created * 1000 < cutoffMs) return true;
  const pricePer1K = getCombinedPrice(model) * 1000;
  return pricePer1K < MIN_PRICE_PER_1K_TOKENS;
}

function transformText(model: RawModel): Model {
  const { provider, displayName } = extractProvider(model);
  return {
    id: model.id,
    name: displayName,
    description: model.description,
    provider,
    modality: 'text',
    contextLength: model.context_length,
    pricePerInputToken: parseTokenPrice(model.pricing.prompt),
    pricePerOutputToken: parseTokenPrice(model.pricing.completion),
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: deriveCapabilities(model.supported_parameters),
    supportedParameters: model.supported_parameters,
    webSearchPrice: model.pricing.web_search
      ? Number.parseFloat(model.pricing.web_search) || undefined
      : undefined,
    created: model.created,
  };
}

interface TextProcessingResult {
  models: Model[];
  premiumIds: string[];
  /** The filtered RawModel pool — used to build the Smart Model entry's price range. */
  filteredPool: RawModel[];
}

function processTextModels(raws: RawModel[]): TextProcessingResult {
  const zdrFiltered = raws.filter((m) => isZdrModel(m.id, 'text'));

  const contexts = zdrFiltered.map((m) => m.context_length);
  const contextThreshold = calculatePercentileThreshold(contexts, TOP_CONTEXT_PERCENTILE);

  const filtered = zdrFiltered.filter((model) => {
    if (isExcludedAlways(model)) return false;
    if (model.context_length >= contextThreshold) return true;
    return !isExcludedByStandardCriteria(model);
  });

  const prices = filtered.map((m) => getCombinedPrice(m));
  const priceThreshold = calculatePercentileThreshold(prices, PREMIUM_PRICE_PERCENTILE);

  const systemPromptChars = buildSystemPrompt([]).length;
  const models: Model[] = [];
  const premiumIds: string[] = [];

  for (const model of filtered) {
    models.push(transformText(model));
    if (isPremiumModel(model, priceThreshold) || exceedsTrialBudget(model, systemPromptChars)) {
      premiumIds.push(model.id);
    }
  }

  return { models, premiumIds, filteredPool: filtered };
}

/**
 * Synthetic Smart Model entry with price ranges derived from the text pool.
 * The Smart Model is not a gateway model — it's a virtual entry the UI can
 * select; the backend resolves the actual model per-message.
 */
function buildSmartModelEntry(pool: RawModel[]): Model {
  const inputPrices = pool.map((m) => parseTokenPrice(m.pricing.prompt));
  const outputPrices = pool.map((m) => parseTokenPrice(m.pricing.completion));
  const contexts = pool.map((m) => m.context_length);

  return {
    id: SMART_MODEL_ID,
    name: 'Smart Model',
    description: 'Automatically picks the best model for each message.',
    provider: 'HushBox',
    modality: 'text',
    contextLength: Math.max(...contexts),
    pricePerInputToken: SMART_MODEL_INPUT_PRICE_PER_TOKEN,
    pricePerOutputToken: SMART_MODEL_OUTPUT_PRICE_PER_TOKEN,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: [],
    isSmartModel: true,
    minPricePerInputToken: Math.min(...inputPrices),
    minPricePerOutputToken: Math.min(...outputPrices),
    maxPricePerInputToken: Math.max(...inputPrices),
    maxPricePerOutputToken: Math.max(...outputPrices),
  };
}

// ============================================================
// Image processing
// ============================================================

function transformImage(model: RawModel): Model {
  const { provider, displayName } = extractProvider(model);
  const perImageRaw = model.pricing.per_image;
  return {
    id: model.id,
    name: displayName,
    description: model.description,
    provider,
    modality: 'image',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: perImageRaw === undefined ? 0 : parseTokenPrice(perImageRaw),
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: model.supported_parameters,
    created: model.created,
  };
}

function hasFlatImagePricing(model: RawModel): boolean {
  const raw = model.pricing.per_image;
  if (raw === undefined) return false;
  return parseTokenPrice(raw) > 0;
}

interface MediaProcessingResult {
  models: Model[];
  premiumIds: string[];
}

function processImageModels(raws: RawModel[]): MediaProcessingResult {
  const zdrFiltered = raws.filter((m) => isZdrModel(m.id, 'image'));
  const priced = zdrFiltered.filter((m) => hasFlatImagePricing(m));
  const models = priced.map((m) => transformImage(m));
  return { models, premiumIds: models.map((m) => m.id) };
}

// ============================================================
// Video processing
// ============================================================

function transformVideo(model: RawModel): Model {
  const { provider, displayName } = extractProvider(model);
  const rawByResolution = model.pricing.per_second_by_resolution ?? {};
  const pricePerSecondByResolution = Object.fromEntries(
    Object.entries(rawByResolution).map(([res, price]) => [res, parseTokenPrice(price)])
  );
  return {
    id: model.id,
    name: displayName,
    description: model.description,
    provider,
    modality: 'video',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: 0,
    pricePerSecondByResolution,
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: model.supported_parameters,
    created: model.created,
  };
}

function hasPerResolutionPricing(model: RawModel): boolean {
  const raw = model.pricing.per_second_by_resolution;
  if (raw === undefined) return false;
  return Object.values(raw).some((p) => parseTokenPrice(p) > 0);
}

function processVideoModels(raws: RawModel[]): MediaProcessingResult {
  const zdrFiltered = raws.filter((m) => isZdrModel(m.id, 'video'));
  const priced = zdrFiltered.filter((m) => hasPerResolutionPricing(m));
  const models = priced.map((m) => transformVideo(m));
  return { models, premiumIds: models.map((m) => m.id) };
}

// ============================================================
// Audio processing
// ============================================================

function transformAudio(model: RawModel): Model {
  const { provider, displayName } = extractProvider(model);
  const perSecondRaw = model.pricing.per_second;
  return {
    id: model.id,
    name: displayName,
    description: model.description,
    provider,
    modality: 'audio',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: perSecondRaw === undefined ? 0 : parseTokenPrice(perSecondRaw),
    capabilities: [],
    supportedParameters: model.supported_parameters,
    created: model.created,
  };
}

function hasFlatAudioPricing(model: RawModel): boolean {
  const raw = model.pricing.per_second;
  if (raw === undefined) return false;
  return parseTokenPrice(raw) > 0;
}

/**
 * Process audio (TTS) models. Symmetric with image/video processing — once the
 * AI Gateway exposes speech models and `ZDR_AUDIO_MODELS` is populated, this
 * naturally returns audio entries. Today the ZDR set is empty so this returns
 * empty even if `FEATURE_FLAGS.AUDIO_ENABLED` is on.
 */
function processAudioModels(raws: RawModel[]): MediaProcessingResult {
  const zdrFiltered = raws.filter((m) => isZdrModel(m.id, 'audio'));
  const priced = zdrFiltered.filter((m) => hasFlatAudioPricing(m));
  const models = priced.map((m) => transformAudio(m));
  return { models, premiumIds: models.map((m) => m.id) };
}

// ============================================================
// Entry point
// ============================================================

function groupByModality(rawModels: RawModel[]): Record<Modality, RawModel[]> {
  const groups: Record<Modality, RawModel[]> = { text: [], image: [], audio: [], video: [] };
  for (const m of rawModels) groups[m.modality].push(m);
  return groups;
}

export function processModels(rawModels: RawModel[]): ProcessedModels {
  const byModality = groupByModality(rawModels);

  const text = processTextModels(byModality.text);
  const image = processImageModels(byModality.image);
  const video = processVideoModels(byModality.video);
  const audio = processAudioModels(byModality.audio);

  const smartPrefix = text.filteredPool.length > 0 ? [buildSmartModelEntry(text.filteredPool)] : [];

  return {
    models: [...text.models, ...smartPrefix, ...image.models, ...video.models, ...audio.models],
    premiumIds: [...text.premiumIds, ...image.premiumIds, ...video.premiumIds, ...audio.premiumIds],
  };
}
