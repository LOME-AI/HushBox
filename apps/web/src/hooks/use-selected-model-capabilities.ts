import { useMemo } from 'react';
import { modelSupportsCapability, type Model } from '@hushbox/shared';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useModels } from '@/hooks/models';

export interface SelectedModelCapabilities {
  selectedModel: Model | undefined;
  supportsSearch: boolean;
  models: Model[];
  premiumIds: Set<string>;
}

export function useSelectedModelCapabilities(): SelectedModelCapabilities {
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const { data: modelsData } = useModels();
  const models = useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();
  const selectedModel = models.find((m) => m.id === getPrimaryModel(selectedModels).id);
  const supportsSearch = selectedModel
    ? modelSupportsCapability(selectedModel, 'web-search')
    : false;

  return { selectedModel, supportsSearch, models, premiumIds };
}
