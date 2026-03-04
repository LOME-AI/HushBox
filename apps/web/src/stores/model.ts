import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STRONGEST_MODEL_ID } from '@hushbox/shared';

interface ModelState {
  selectedModelId: string;
  selectedModelName: string;
  setSelectedModel: (modelId: string, modelName: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelId: STRONGEST_MODEL_ID,
      selectedModelName: '',
      setSelectedModel: (modelId, modelName) =>
        set({ selectedModelId: modelId, selectedModelName: modelName }),
    }),
    {
      name: 'hushbox-model-storage',
    }
  )
);
