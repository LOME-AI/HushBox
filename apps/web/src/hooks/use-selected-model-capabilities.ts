import { useMemo } from 'react';
import { type Model } from '@hushbox/shared';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useModels } from '@/hooks/models';

export interface SelectedModelCapabilities {
  selectedModel: Model | undefined;
  models: Model[];
  premiumIds: Set<string>;
}

export function useSelectedModelCapabilities(): SelectedModelCapabilities {
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const { data: modelsData } = useModels();
  const models = useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();
  const selectedModel = models.find((m) => m.id === getPrimaryModel(selectedModels).id);

  return { selectedModel, models, premiumIds };
}
