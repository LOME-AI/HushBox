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

export type PickerMode = 'single' | 'multi';

export interface ModelStoreState {
  activeModality: Modality;
  selections: Record<Modality, SelectedModelEntry[]>;
  /**
   * Per-modality picker mode preference. Stored per-modality so a user can
   * prefer single-select for text (fast swap) and multi-select for image
   * (compare visual styles). Persisted via the model store's persist middleware.
   */
  pickerMode: Record<Modality, PickerMode>;
  imageConfig: ImageConfig;
  videoConfig: VideoConfig;
  audioConfig: AudioConfig;

  setActiveModality: (modality: Modality) => void;
  setSelectedModels: (modality: Modality, entries: SelectedModelEntry[]) => void;
  toggleModel: (modality: Modality, entry: SelectedModelEntry) => void;
  removeModel: (modality: Modality, modelId: string) => void;
  clearSelection: (modality: Modality) => void;
  setPickerMode: (modality: Modality, mode: PickerMode) => void;
  /**
   * Resets state for an unauthenticated user: forces text modality (so the
   * trial chat page never lands with image/video/audio active and all icons
   * disabled), clears every modality selection, and resets pickerMode to
   * single across modalities so the next picker open is in the simpler mode.
   */
  resetForUnauthenticated: () => void;
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

function defaultPickerMode(): Record<Modality, PickerMode> {
  return { text: 'single', image: 'single', audio: 'single', video: 'single' };
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

function entriesEqual(a: SelectedModelEntry[], b: SelectedModelEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.id === b[index]?.id);
}

// Returning the same `state` reference when the next entries are structurally
// equal short-circuits Zustand's subscriber broadcast; this is the bottom-layer
// defense against effect loops in callers like `useModelValidation` that may
// re-derive a structurally identical replacement on every render.
function updateModalitySelection(
  state: ModelStoreState,
  modality: Modality,
  next: SelectedModelEntry[]
): ModelStoreState | Pick<ModelStoreState, 'selections'> {
  if (entriesEqual(state.selections[modality], next)) return state;
  return { selections: { ...state.selections, [modality]: next } };
}

export const useModelStore = create<ModelStoreState>()(
  persist(
    (set) => ({
      activeModality: 'text',
      selections: defaultSelections(),
      pickerMode: defaultPickerMode(),
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

      setPickerMode: (modality, mode) =>
        set((state) => {
          if (state.pickerMode[modality] === mode) return state;
          return { pickerMode: { ...state.pickerMode, [modality]: mode } };
        }),

      resetForUnauthenticated: () =>
        set(() => ({
          activeModality: 'text',
          selections: defaultSelections(),
          pickerMode: defaultPickerMode(),
        })),

      setImageConfig: (config) =>
        set((state) => ({ imageConfig: { ...state.imageConfig, ...config } })),

      setVideoConfig: (config) =>
        set((state) => ({ videoConfig: { ...state.videoConfig, ...config } })),

      setAudioConfig: (config) =>
        set((state) => ({ audioConfig: { ...state.audioConfig, ...config } })),
    }),
    {
      name: 'hushbox-model-storage',
      partialize: (state) => ({
        activeModality: state.activeModality,
        selections: state.selections,
        pickerMode: state.pickerMode,
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
