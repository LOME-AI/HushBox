import { useQuery } from '@tanstack/react-query';
import type { Model, ModelsListResponse } from '@lome-chat/shared';
import { STRONGEST_MODEL_ID, VALUE_MODEL_ID, getModelCostPer1k } from '@lome-chat/shared';
import { api } from '../lib/api.js';

export interface ModelsData {
  models: Model[];
  premiumIds: Set<string>;
}

export const modelKeys = {
  all: ['models'] as const,
  list: () => [...modelKeys.all, 'list'] as const,
  detail: (id: string) => [...modelKeys.all, id] as const,
};

export function useModels(): ReturnType<typeof useQuery<ModelsData, Error>> {
  return useQuery({
    queryKey: modelKeys.list(),
    queryFn: async (): Promise<ModelsData> => {
      const response = await api.get<ModelsListResponse>('/models');
      return {
        models: response.models,
        premiumIds: new Set(response.premiumModelIds),
      };
    },
    staleTime: 1000 * 60 * 60,
  });
}

/**
 * Get the strongest and value model IDs based on user tier.
 *
 * For paid users (canAccessPremium=true): returns hardcoded premium model IDs.
 * For free/guest users: returns the most expensive and cheapest basic (non-premium) models.
 *
 * @param models - Array of available models
 * @param premiumIds - Set of premium model IDs
 * @param canAccessPremium - Whether user can access premium models
 * @returns Object with strongestId and valueId
 */
export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean
): { strongestId: string; valueId: string } {
  if (canAccessPremium) {
    return { strongestId: STRONGEST_MODEL_ID, valueId: VALUE_MODEL_ID };
  }

  const basicModels = models.filter((m) => !premiumIds.has(m.id));
  if (basicModels.length === 0) {
    return { strongestId: models[0]?.id ?? '', valueId: models[0]?.id ?? '' };
  }

  const sorted = [...basicModels].sort((a, b) => {
    const priceA = getModelCostPer1k(a.pricePerInputToken, a.pricePerOutputToken);
    const priceB = getModelCostPer1k(b.pricePerInputToken, b.pricePerOutputToken);
    return priceB - priceA;
  });

  return {
    strongestId: sorted[0]?.id ?? '',
    valueId: sorted[sorted.length - 1]?.id ?? '',
  };
}
