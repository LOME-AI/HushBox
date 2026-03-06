import type { OpenRouterModel, ZdrEndpoint } from './types.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

/**
 * Fetch models from OpenRouter API without authentication.
 * The /models endpoint is public and does not require an API key.
 */
export async function fetchModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(`${OPENROUTER_API_URL}/models`);

  if (!response.ok) {
    throw new Error('Failed to fetch models');
  }

  const data = (await response.json()) as { data: OpenRouterModel[] };
  return data.data;
}

/**
 * Fetch ZDR-compliant model IDs from OpenRouter.
 * The /endpoints/zdr endpoint is public — no API key required.
 * Works identically in dev, CI, and production.
 */
export async function fetchZdrModelIds(): Promise<Set<string>> {
  const response = await fetch(`${OPENROUTER_API_URL}/endpoints/zdr`);

  if (!response.ok) {
    throw new Error('Failed to fetch ZDR endpoints');
  }

  const data = (await response.json()) as { data: ZdrEndpoint[] };
  return new Set(data.data.map((ep) => ep.model_id));
}
