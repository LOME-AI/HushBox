import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AUTO_ROUTER_MODEL_ID, MAX_SELECTED_MODELS } from '@hushbox/shared';

export const DEFAULT_MODEL_ID = AUTO_ROUTER_MODEL_ID;
export const DEFAULT_MODEL_NAME = 'Smart Model';

export interface SelectedModelEntry {
  id: string;
  name: string;
}

interface ModelState {
  selectedModels: SelectedModelEntry[];
  setSelectedModel: (modelId: string, modelName: string) => void;
  toggleModel: (modelId: string, modelName: string) => void;
  removeModel: (modelId: string) => void;
  clearSelection: () => void;
}

const DEFAULT_ENTRY: SelectedModelEntry = { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME };

export function getPrimaryModel(models: SelectedModelEntry[]): SelectedModelEntry {
  return models[0] ?? DEFAULT_ENTRY;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModels: [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME }],

      setSelectedModel: (modelId, modelName) =>
        set({ selectedModels: [{ id: modelId, name: modelName }] }),

      toggleModel: (modelId, modelName) =>
        set((state) => {
          const index = state.selectedModels.findIndex((m) => m.id === modelId);
          if (index !== -1) {
            // Already selected — remove if more than 1
            if (state.selectedModels.length <= 1) return state;
            return { selectedModels: state.selectedModels.filter((_, index_) => index_ !== index) };
          }
          // Not selected — add if under limit
          if (state.selectedModels.length >= MAX_SELECTED_MODELS) return state;
          return { selectedModels: [...state.selectedModels, { id: modelId, name: modelName }] };
        }),

      removeModel: (modelId) =>
        set((state) => {
          if (state.selectedModels.length <= 1) return state;
          const filtered = state.selectedModels.filter((m) => m.id !== modelId);
          if (filtered.length === state.selectedModels.length) return state;
          return { selectedModels: filtered };
        }),

      clearSelection: () =>
        set((state) => ({
          selectedModels: [getPrimaryModel(state.selectedModels)],
        })),
    }),
    {
      name: 'hushbox-model-storage',
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0) {
          const old = persisted as { selectedModelId?: string; selectedModelName?: string };
          return {
            selectedModels: [
              {
                id: old.selectedModelId ?? DEFAULT_MODEL_ID,
                name: old.selectedModelName ?? DEFAULT_MODEL_NAME,
              },
            ],
          };
        }
        return persisted as ModelState;
      },
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<ModelState>) };
        if (state.selectedModels.length === 0) {
          state.selectedModels = [DEFAULT_ENTRY];
        }
        return state;
      },
    }
  )
);

// Guard: reset to default if selectedModels is ever set to empty
useModelStore.subscribe((state) => {
  if (state.selectedModels.length === 0) {
    useModelStore.setState({ selectedModels: [DEFAULT_ENTRY] });
  }
});
