import { createGateway } from '@ai-sdk/gateway';
import type { RawModel } from './types.js';

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
// Defaults for fields the AI Gateway doesn't return
// ============================================================================

/** Default context length applied to all models — gateway doesn't report this. */
const DEFAULT_CONTEXT_LENGTH = 128_000;

// ============================================================================
// Shape of the gateway's /config response. We mirror only the fields we consume.
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

/**
 * Map a gateway model entry to our internal RawModel shape.
 *
 * Fields the gateway doesn't return (context_length, created,
 * supported_parameters, architecture) are defaulted. These fields are retained
 * on the type for compatibility with downstream consumers; future cleanup can
 * remove them as consumers are updated.
 */
function toRawModel(entry: GatewayModelEntry): RawModel {
  const modelType = entry.modelType ?? 'language';
  const isTextModel = modelType === 'language';

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? '',
    context_length: DEFAULT_CONTEXT_LENGTH,
    pricing: {
      prompt: entry.pricing?.input ?? '0',
      completion: entry.pricing?.output ?? '0',
    },
    supported_parameters: [],
    created: 0,
    architecture: {
      input_modalities: isTextModel ? ['text'] : [modelType],
      output_modalities: isTextModel ? ['text'] : [modelType],
    },
  };
}

/**
 * Fetch available models from the Vercel AI Gateway.
 * Requires an API key — the gateway's /config endpoint is authenticated.
 * Results are cached in memory for 1 hour per API key.
 */
export async function fetchModels(apiKey: string): Promise<RawModel[]> {
  if (modelsCache?.apiKey === apiKey && Date.now() < modelsCache.expiresAt) {
    return modelsCache.data;
  }

  const gateway = createGateway({ apiKey });
  const response = await gateway.getAvailableModels();
  const mapped = response.models.map((m) => toRawModel(m as GatewayModelEntry));

  modelsCache = {
    apiKey,
    data: mapped,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
  };

  return mapped;
}
