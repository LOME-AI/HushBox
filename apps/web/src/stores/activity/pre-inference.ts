import { create } from 'zustand';

interface PreInferenceActivityState {
  preInferenceStagesSeen: number;
  markStageSeen: () => void;
}

/**
 * Monotonic count of pre-inference stages observed — today only the Smart Model
 * classifier, counted once per Smart tile when the answer stream's
 * `stream-start` label delivers the resolved model. Incremented from
 * `useAuthenticatedChat`'s resolved-model handlers.
 *
 * The count drives no UI. Its only reader is `MessageList`, which renders it as
 * `data-pre-inference-stages-seen` so E2E can capture a baseline before an
 * action and wait for it to advance.
 */
export const usePreInferenceActivityStore = create<PreInferenceActivityState>()((set) => ({
  preInferenceStagesSeen: 0,
  markStageSeen: () => {
    set((state) => ({ preInferenceStagesSeen: state.preInferenceStagesSeen + 1 }));
  },
}));
