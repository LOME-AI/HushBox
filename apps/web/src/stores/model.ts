import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ModelState {
  selectedModelId: string;
  selectedModelName: string;
  setSelectedModel: (modelId: string, modelName: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelId: 'openai/gpt-4-turbo',
      selectedModelName: 'GPT-4 Turbo',
      setSelectedModel: (modelId, modelName) =>
        set({ selectedModelId: modelId, selectedModelName: modelName }),
    }),
    {
      name: 'hushbox-model-storage',
    }
  )
);
