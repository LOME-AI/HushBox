import { createGateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import type { Modality, RawModel } from './types.js';

// ============================================================================
// Cache — 1-hour TTL. Key includes the API key to prevent cross-tenant leaks
// if the cache instance ever serves multiple keys (defensive; in production
// there's one key per Worker).
// ============================================================================

interface CacheEntry {
  apiKey: string;
  data: RawModel[];
  expiresAt: number;
}

const MODEL_CACHE_TTL_MS = 3_600_000;

let modelsCache: CacheEntry | null = null;

/** Test-only: clears the in-memory model cache. */
export function clearModelCache(): void {
  modelsCache = null;
}

// ============================================================================
// Defaults for fields neither endpoint returns
// ============================================================================

const DEFAULT_CONTEXT_LENGTH = 128_000;

// ============================================================================
// SDK `/config` response (strongly typed via @ai-sdk/gateway)
// ============================================================================

interface GatewayModelEntry {
  id: string;
  name: string;
  description?: string | null;
  pricing?: {
    input: string;
    output: string;
  } | null;
  modelType?: 'language' | 'embedding' | 'image' | 'video' | null;
  specification?: {
    provider: string;
    modelId: string;
  };
}

// ============================================================================
// Public `/v1/models` response (not SDK-typed — source of media pricing).
// Zod-validated at parse time so schema drift at Vercel fails loudly rather
// than silently emitting `undefined` into the pricing pipeline.
// ============================================================================

const videoDurationPricingEntrySchema = z.object({
  resolution: z.string(),
  audio: z.boolean(),
  cost_per_second: z.string(),
});

/**
 * Per-entry schema is permissive on unknown fields (passthrough) but strict
 * on the fields we actually consume. Unknown-shape entries get filtered
 * downstream in `processModels` via the `has flat pricing` check — no need
 * to fail the whole batch over a single unknown pricing variant.
 */
const publicModelEntrySchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
});

type PublicModelEntry = z.infer<typeof publicModelEntrySchema>;

const publicModelsResponseSchema = z.object({
  data: z.array(publicModelEntrySchema),
});

/**
 * Classifies a model's modality from the SDK `modelType` field.
 * The SDK enum is `'language' | 'embedding' | 'image' | 'video'`; we collapse
 * embedding and anything unknown to `'text'` (embeddings aren't user-selectable
 * in our UI and won't pass ZDR filters anyway).
 */
function classifyModality(modelType: string | null | undefined): Modality {
  switch (modelType) {
    case 'image': {
      return 'image';
    }
    case 'video': {
      return 'video';
    }
    default: {
      return 'text';
    }
  }
}

/**
 * Extract flat per-image price from a public-endpoint entry.
 * Returns undefined for empty pricing or variable (`image_dimension_quality_pricing`)
 * entries, which are filtered out downstream in processModels.
 */
function extractImagePricing(pricing: Record<string, unknown> | undefined): string | undefined {
  if (!pricing) return undefined;
  const flat = pricing['image'];
  if (typeof flat === 'string') return flat;
  return undefined;
}

/**
 * Extract per-resolution per-second prices from a public-endpoint entry.
 * Prefers the `audio: true` entry per resolution (plan §9.1a: HushBox always
 * requests audio when the model supports it). Falls back to `audio: false`
 * when only that variant is priced. Returns undefined for video models that
 * use `video_token_pricing` (per-token billing, out of scope for v1) or when
 * `video_duration_pricing` entries fail validation.
 */
function extractVideoPricing(
  pricing: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!pricing) return undefined;
  const raw = pricing['video_duration_pricing'];
  if (!Array.isArray(raw)) return undefined;
  const parsed = z.array(videoDurationPricingEntrySchema).safeParse(raw);
  if (!parsed.success) return undefined;
  const byResolution: Record<string, string> = {};
  for (const entry of parsed.data) {
    const existing = byResolution[entry.resolution];
    // Set if empty OR upgrade from audio:false to audio:true
    if (existing === undefined || entry.audio) {
      byResolution[entry.resolution] = entry.cost_per_second;
    }
  }
  return byResolution;
}

/**
 * Fetch the unauthenticated public `/v1/models` endpoint for media pricing.
 * Never throws — any failure (network error, non-2xx, malformed body, schema
 * drift) is logged and returns an empty map. Downstream `processModels` filters
 * out media entries without pricing, so a degraded public endpoint leaves text
 * models working while media models silently drop off the catalog.
 */
async function fetchPublicModels(url: string): Promise<Map<string, PublicModelEntry>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Public models endpoint returned ${String(response.status)}`);
      return new Map();
    }
    const body = (await response.json()) as unknown;
    const parsed = publicModelsResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.warn('Public models response shape changed:', parsed.error.issues);
      return new Map();
    }
    return new Map(parsed.data.data.map((entry) => [entry.id, entry]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Public models fetch failed:', message);
    return new Map();
  }
}

function mergeMediaPricing(
  modality: Modality,
  publicEntry: PublicModelEntry | undefined
): Partial<RawModel['pricing']> {
  if (publicEntry === undefined) return {};
  if (modality === 'image') {
    const perImage = extractImagePricing(publicEntry.pricing);
    return perImage === undefined ? {} : { per_image: perImage };
  }
  if (modality === 'video') {
    const byRes = extractVideoPricing(publicEntry.pricing);
    return byRes === undefined ? {} : { per_second_by_resolution: byRes };
  }
  return {};
}

function toRawModel(entry: GatewayModelEntry, publicEntry: PublicModelEntry | undefined): RawModel {
  const modality = classifyModality(entry.modelType);
  const isText = modality === 'text';

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? '',
    modality,
    context_length: DEFAULT_CONTEXT_LENGTH,
    pricing: {
      prompt: entry.pricing?.input ?? '0',
      completion: entry.pricing?.output ?? '0',
      ...mergeMediaPricing(modality, publicEntry),
    },
    supported_parameters: [],
    created: 0,
    architecture: {
      input_modalities: isText ? ['text'] : [modality],
      output_modalities: isText ? ['text'] : [modality],
    },
  };
}

export interface FetchModelsOptions {
  apiKey: string;
  /**
   * URL of the unauthenticated `/v1/models` endpoint (source of media pricing).
   * Configurable per environment via `envConfig.PUBLIC_MODELS_URL` so tests can
   * point at a fixture and production can be retargeted without a code change.
   */
  publicModelsUrl: string;
}

/**
 * Fetch available models from the Vercel AI Gateway.
 * Merges two sources: the SDK's authenticated `/config` endpoint (authoritative
 * catalog for our API key) and the unauthenticated public `/v1/models` endpoint
 * (source of per-image / per-second media pricing — neither field is exposed
 * via the SDK's typed response).
 *
 * Results are cached in memory for 1 hour per API key.
 */
export async function fetchModels(options: FetchModelsOptions): Promise<RawModel[]> {
  const { apiKey, publicModelsUrl } = options;
  if (modelsCache?.apiKey === apiKey && Date.now() < modelsCache.expiresAt) {
    return modelsCache.data;
  }

  const gateway = createGateway({ apiKey });
  const [sdkResponse, publicMap] = await Promise.all([
    gateway.getAvailableModels(),
    fetchPublicModels(publicModelsUrl),
  ]);

  const entries = (sdkResponse as { models: GatewayModelEntry[] }).models;
  const merged = entries.map((entry) => toRawModel(entry, publicMap.get(entry.id)));

  modelsCache = {
    apiKey,
    data: merged,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
  };

  return merged;
}
