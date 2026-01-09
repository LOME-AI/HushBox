import { useQuery } from '@tanstack/react-query';
import type { Model, ModelsListResponse } from '@lome-chat/shared';
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
