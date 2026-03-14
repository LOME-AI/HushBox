import type { OpenRouterModel, ZdrEndpoint } from './types.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// ============================================================================
// In-memory TTL cache for model endpoints
// ============================================================================

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const MODEL_CACHE_TTL_MS = 3_600_000; // 1 hour

let modelsCache: CacheEntry<OpenRouterModel[]> | null = null;
let zdrCache: CacheEntry<Set<string>> | null = null;

/** @internal — test-only: clears the in-memory model/ZDR cache */
export function clearModelCache(): void {
  modelsCache = null;
  zdrCache = null;
}

/**
 * Fetch models from OpenRouter API without authentication.
 * The /models endpoint is public and does not require an API key.
 * Results are cached in memory for 1 hour.
 */
export async function fetchModels(): Promise<OpenRouterModel[]> {
  if (modelsCache && Date.now() < modelsCache.expiresAt) {
    return modelsCache.data;
  }

  const response = await fetch(`${OPENROUTER_API_URL}/models`);

  if (!response.ok) {
    throw new Error('Failed to fetch models');
  }

  const data = (await response.json()) as { data: OpenRouterModel[] };
  modelsCache = { data: data.data, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return data.data;
}

/**
 * Fetch ZDR-compliant model IDs from OpenRouter.
 * The /endpoints/zdr endpoint is public — no API key required.
 * Results are cached in memory for 1 hour.
 */
export async function fetchZdrModelIds(): Promise<Set<string>> {
  if (zdrCache && Date.now() < zdrCache.expiresAt) {
    return zdrCache.data;
  }

  const response = await fetch(`${OPENROUTER_API_URL}/endpoints/zdr`);

  if (!response.ok) {
    throw new Error('Failed to fetch ZDR endpoints');
  }

  const data = (await response.json()) as { data: ZdrEndpoint[] };
  const result = new Set(data.data.map((ep) => ep.model_id));
  zdrCache = { data: result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return result;
}
