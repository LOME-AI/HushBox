import { create } from 'zustand';

interface PreInferenceActivityState {
  preInferenceStagesSeen: number;
  markStageSeen: () => void;
}

/**
 * Monotonic count of pre-inference stages observed (today only the Smart Model
 * classifier — `stage:start` is generic over stage types). Exposed as
 * `data-pre-inference-stages-seen` so E2E can prove a Smart Model turn ran its
 * stage via a baseline-then-advance assertion instead of racing the transient
 * "Choosing the best model…" indicator (instant in tests).
 */
export const usePreInferenceActivityStore = create<PreInferenceActivityState>()((set) => ({
  preInferenceStagesSeen: 0,
  markStageSeen: () => {
    set((state) => ({ preInferenceStagesSeen: state.preInferenceStagesSeen + 1 }));
  },
}));
