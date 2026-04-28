import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SMART_MODEL_ID, MAX_SELECTED_MODELS, MAX_AUDIO_DURATION_SECONDS } from '@hushbox/shared';
import type { Modality, ImageConfig, VideoConfig, AudioConfig } from '@hushbox/shared';

export const DEFAULT_MODEL_ID = SMART_MODEL_ID;
export const DEFAULT_MODEL_NAME = 'Smart Model';

export interface SelectedModelEntry {
  id: string;
  name: string;
}

export interface ModelStoreState {
  activeModality: Modality;
  selections: Record<Modality, SelectedModelEntry[]>;
  imageConfig: ImageConfig;
  videoConfig: VideoConfig;
  audioConfig: AudioConfig;

  setActiveModality: (modality: Modality) => void;
  setSelectedModels: (modality: Modality, entries: SelectedModelEntry[]) => void;
  toggleModel: (modality: Modality, entry: SelectedModelEntry) => void;
  removeModel: (modality: Modality, modelId: string) => void;
  clearSelection: (modality: Modality) => void;
  setImageConfig: (config: Partial<ImageConfig>) => void;
  setVideoConfig: (config: Partial<VideoConfig>) => void;
  setAudioConfig: (config: Partial<AudioConfig>) => void;
}

const DEFAULT_TEXT_ENTRY: SelectedModelEntry = {
  id: DEFAULT_MODEL_ID,
  name: DEFAULT_MODEL_NAME,
};
const BLANK_ENTRY: SelectedModelEntry = { id: '', name: '' };

const DEFAULT_IMAGE_CONFIG: ImageConfig = { aspectRatio: '1:1' };
const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  aspectRatio: '16:9',
  durationSeconds: 4,
  resolution: '720p',
};
const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  format: 'mp3',
  maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS,
};

function defaultSelections(): Record<Modality, SelectedModelEntry[]> {
  return { text: [DEFAULT_TEXT_ENTRY], image: [], audio: [], video: [] };
}

/**
 * Guarantees `selections.text` always has at least one entry. Returns the input
 * unchanged when text is non-empty so callers can use reference equality to skip
 * unnecessary state updates.
 */
function ensureTextNonEmpty(
  selections: Record<Modality, SelectedModelEntry[]>
): Record<Modality, SelectedModelEntry[]> {
  if (selections.text.length > 0) return selections;
  return { ...selections, text: [DEFAULT_TEXT_ENTRY] };
}

export function getPrimaryModel(
  entries: SelectedModelEntry[],
  modality: Modality = 'text'
): SelectedModelEntry {
  const entry = entries[0];
  if (entry) return entry;
  return modality === 'text' ? DEFAULT_TEXT_ENTRY : BLANK_ENTRY;
}

function updateModalitySelection(
  state: ModelStoreState,
  modality: Modality,
  next: SelectedModelEntry[]
): Pick<ModelStoreState, 'selections'> {
  return { selections: { ...state.selections, [modality]: next } };
}

export const useModelStore = create<ModelStoreState>()(
  persist(
    (set) => ({
      activeModality: 'text',
      selections: defaultSelections(),
      imageConfig: { ...DEFAULT_IMAGE_CONFIG },
      videoConfig: { ...DEFAULT_VIDEO_CONFIG },
      audioConfig: { ...DEFAULT_AUDIO_CONFIG },

      setActiveModality: (modality) =>
        set((state) => {
          if (state.activeModality === modality) return state;
          return { activeModality: modality };
        }),

      setSelectedModels: (modality, entries) =>
        set((state) => updateModalitySelection(state, modality, entries)),

      toggleModel: (modality, entry) =>
        set((state) => {
          const current = state.selections[modality];
          const existingIndex = current.findIndex((m) => m.id === entry.id);
          if (existingIndex !== -1) {
            // Already selected — remove. Text must keep at least one entry.
            if (modality === 'text' && current.length <= 1) return state;
            return updateModalitySelection(
              state,
              modality,
              current.filter((_, index) => index !== existingIndex)
            );
          }
          if (current.length >= MAX_SELECTED_MODELS) return state;
          return updateModalitySelection(state, modality, [...current, entry]);
        }),

      removeModel: (modality, modelId) =>
        set((state) => {
          const current = state.selections[modality];
          if (modality === 'text' && current.length <= 1) return state;
          const filtered = current.filter((m) => m.id !== modelId);
          if (filtered.length === current.length) return state;
          return updateModalitySelection(state, modality, filtered);
        }),

      clearSelection: (modality) =>
        set((state) => {
          const current = state.selections[modality];
          if (modality === 'text') {
            return updateModalitySelection(state, modality, [getPrimaryModel(current, 'text')]);
          }
          if (current.length === 0) return state;
          return updateModalitySelection(state, modality, []);
        }),

      setImageConfig: (config) =>
        set((state) => ({ imageConfig: { ...state.imageConfig, ...config } })),

      setVideoConfig: (config) =>
        set((state) => ({ videoConfig: { ...state.videoConfig, ...config } })),

      setAudioConfig: (config) =>
        set((state) => ({ audioConfig: { ...state.audioConfig, ...config } })),
    }),
    {
      name: 'hushbox-model-storage',
      version: 2,
      migrate: (persisted, version) => {
        let state = persisted;
        if (version === 0) {
          const old = state as { selectedModelId?: string; selectedModelName?: string };
          state = {
            selectedModels: [
              {
                id: old.selectedModelId ?? DEFAULT_MODEL_ID,
                name: old.selectedModelName ?? DEFAULT_MODEL_NAME,
              },
            ],
            activeModality: 'text',
          };
        }
        // v0 was normalized to v1 shape above; this branch then applies v1 → v2.
        if (version <= 1) {
          const old = state as {
            selectedModels?: SelectedModelEntry[];
            activeModality?: 'text' | 'image';
          };
          const previousModality = old.activeModality ?? 'text';
          const previousSelections = old.selectedModels ?? [];
          const selections: Record<Modality, SelectedModelEntry[]> = {
            text: previousModality === 'text' ? previousSelections : [DEFAULT_TEXT_ENTRY],
            image: previousModality === 'image' ? previousSelections : [],
            audio: [],
            video: [],
          };
          return {
            activeModality: previousModality,
            selections,
          };
        }
        return state;
      },
      partialize: (state) => ({
        activeModality: state.activeModality,
        selections: state.selections,
      }),
      merge: (persisted, current) => {
        const merged: ModelStoreState = {
          ...current,
          ...(persisted as Partial<ModelStoreState>),
        };
        merged.selections = ensureTextNonEmpty(merged.selections);
        return merged;
      },
    }
  )
);

// Guard: text selection must never be empty. Image/audio/video may legitimately be empty.
// `ensureTextNonEmpty` returns the same reference when text is non-empty, so setState
// is only called when a restoration is actually needed.
useModelStore.subscribe((state) => {
  const next = ensureTextNonEmpty(state.selections);
  if (next !== state.selections) {
    useModelStore.setState({ selections: next });
  }
});

export { type ImageConfig, type VideoConfig, type AudioConfig } from '@hushbox/shared';
