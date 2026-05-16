import { create } from 'zustand';
import type { StateCreator } from 'zustand';

export interface TtsPlaybackStore {
  /** Id of the message whose audio is currently playing, or null when idle. */
  speakingStreamId: string | null;
  /**
   * Ids of streams the user explicitly stopped via the Stop button. Looked up
   * by the feeder to skip any sentences that still arrive after the click,
   * and by the inline notice that points the user at /accessibility.
   */
  stoppedStreamIds: ReadonlySet<string>;
  setSpeakingStream: (id: string) => void;
  /** Clear only if the currently-speaking id matches; avoids a late end()
   *  for an older stream clobbering a newer one that just started. */
  clearSpeakingStreamIfMatches: (id: string) => void;
  markStreamStopped: (id: string) => void;
}

const stateCreator: StateCreator<TtsPlaybackStore> = (set) => ({
  speakingStreamId: null,
  stoppedStreamIds: new Set<string>(),
  setSpeakingStream: (id) => {
    set({ speakingStreamId: id });
  },
  clearSpeakingStreamIfMatches: (id) => {
    set((state) => (state.speakingStreamId === id ? { speakingStreamId: null } : state));
  },
  markStreamStopped: (id) => {
    set((state) => {
      const nextStopped = new Set(state.stoppedStreamIds);
      nextStopped.add(id);
      return {
        stoppedStreamIds: nextStopped,
        speakingStreamId: state.speakingStreamId === id ? null : state.speakingStreamId,
      };
    });
  },
});

export function createTtsPlaybackStore() {
  return create<TtsPlaybackStore>()(stateCreator);
}

export const useTtsPlaybackStore = createTtsPlaybackStore();
