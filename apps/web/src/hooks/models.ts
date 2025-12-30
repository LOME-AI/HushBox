import { useQuery } from '@tanstack/react-query';
import type { Model, ModelCapability } from '@lome-chat/shared';
import { api } from '../lib/api.js';

/**
 * Patterns for models that should be excluded from the selector.
 */
const EXCLUDED_MODEL_PATTERNS = [/body builder/i, /auto router/i];

/**
 * Determine if a model should be excluded from the selector.
 * Excludes:
 * - Free models (both input and output price = 0)
 * - Utility models like Body Builder and Auto Router
 */
export function isExcludedModel(model: Model): boolean {
  // Free models
  if (model.pricePerInputToken === 0 && model.pricePerOutputToken === 0) {
    return true;
  }
  // Utility models by name pattern
  return EXCLUDED_MODEL_PATTERNS.some((pattern) => pattern.test(model.name));
}

/**
 * API response format from OpenRouter (via our backend).
 */
interface ApiModelInfo {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  supported_parameters: string[];
}

/**
 * Provider name mapping from model ID prefix.
 */
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

/**
 * Extract provider name from model ID prefix.
 * Model IDs are formatted as "provider/model-name" (e.g., "openai/gpt-4-turbo").
 */
function extractProviderFromId(modelId: string): string {
  const prefix = modelId.split('/')[0] ?? '';
  return PROVIDER_MAP[prefix] ?? 'Unknown';
}

/**
 * Extract provider and clean name from model name format "Provider: Model Name".
 * Returns null if name doesn't match this format.
 */
function extractProviderFromName(name: string): { provider: string; cleanName: string } | null {
  const match = /^([^:]+):\s*(.+)$/.exec(name);
  if (match?.[1] && match[2]) {
    return { provider: match[1].trim(), cleanName: match[2].trim() };
  }
  return null;
}

/**
 * Derive capabilities from supported_parameters.
 * - 'tools' or 'tool_choice' → functions
 * - 'response_format' → json-mode
 * - All models support streaming by default
 */
function deriveCapabilities(supportedParams: string[]): ModelCapability[] {
  const capabilities: ModelCapability[] = ['streaming'];

  if (supportedParams.includes('tools') || supportedParams.includes('tool_choice')) {
    capabilities.push('functions');
  }

  if (supportedParams.includes('response_format')) {
    capabilities.push('json-mode');
  }

  // Vision detection would require additional model metadata
  // For now, we could add it based on known model patterns if needed

  return capabilities;
}

/**
 * Transform API model format to frontend Model format.
 * Extracts provider from name (format "Provider: Model Name") or falls back to ID prefix.
 * Cleans name by removing provider prefix when present.
 */
export function transformApiModel(apiModel: ApiModelInfo): Model {
  // Try to extract provider from name first (format "Provider: Model Name")
  const extracted = extractProviderFromName(apiModel.name);

  let provider: string;
  let displayName: string;

  if (extracted) {
    provider = extracted.provider;
    displayName = extracted.cleanName;
  } else {
    provider = extractProviderFromId(apiModel.id);
    displayName = apiModel.name;
  }

  return {
    id: apiModel.id,
    name: displayName,
    description: apiModel.description,
    provider,
    contextLength: apiModel.context_length,
    pricePerInputToken: parseFloat(apiModel.pricing.prompt),
    pricePerOutputToken: parseFloat(apiModel.pricing.completion),
    capabilities: deriveCapabilities(apiModel.supported_parameters),
    supportedParameters: apiModel.supported_parameters,
  };
}

// Query key factory
export const modelKeys = {
  all: ['models'] as const,
  list: () => [...modelKeys.all, 'list'] as const,
  detail: (id: string) => [...modelKeys.all, id] as const,
};

/**
 * Hook to fetch available AI models.
 */
export function useModels(): ReturnType<typeof useQuery<Model[], Error>> {
  return useQuery({
    queryKey: modelKeys.list(),
    queryFn: async (): Promise<Model[]> => {
      const apiModels = await api.get<ApiModelInfo[]>('/models');
      return apiModels.map(transformApiModel).filter((model) => !isExcludedModel(model));
    },
    staleTime: 1000 * 60 * 60, // 1 hour - models don't change often
  });
}
