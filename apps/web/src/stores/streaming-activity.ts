import { create } from 'zustand';

interface StreamingActivityState {
  activeStreams: number;
  startStream: () => void;
  endStream: () => void;
}

export const useStreamingActivityStore = create<StreamingActivityState>()((set) => ({
  activeStreams: 0,

  startStream: () => {
    set((state) => ({ activeStreams: state.activeStreams + 1 }));
  },

  endStream: () => {
    set((state) => ({ activeStreams: Math.max(0, state.activeStreams - 1) }));
  },
}));
