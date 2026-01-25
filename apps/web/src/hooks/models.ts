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
      const response = await api.get<ModelsListResponse>('/api/models');
      return {
        models: response.models,
        premiumIds: new Set(response.premiumModelIds),
      };
    },
    staleTime: 1000 * 60 * 60,
  });
}

function findStrongestAndValueBasicModels(
  models: Model[],
  premiumIds: Set<string>
): { strongestId: string; valueId: string } {
  const basicModels = models.filter((m) => !premiumIds.has(m.id));
  if (basicModels.length === 0) {
    const fallback = models[0]?.id ?? '';
    return { strongestId: fallback, valueId: fallback };
  }

  const sorted = [...basicModels].toSorted((a, b) => {
    const priceA = getModelCostPer1k(a.pricePerInputToken, a.pricePerOutputToken);
    const priceB = getModelCostPer1k(b.pricePerInputToken, b.pricePerOutputToken);
    return priceB - priceA;
  });

  return {
    strongestId: sorted[0]?.id ?? '',
    valueId: sorted.at(-1)?.id ?? '',
  };
}

export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean
): { strongestId: string; valueId: string } {
  if (canAccessPremium) {
    return { strongestId: STRONGEST_MODEL_ID, valueId: VALUE_MODEL_ID };
  }
  return findStrongestAndValueBasicModels(models, premiumIds);
}
