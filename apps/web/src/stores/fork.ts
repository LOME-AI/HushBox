import { create } from 'zustand';

interface ForkState {
  activeForkId: string | null;

  setActiveFork: (id: string | null) => void;
}

export const useForkStore = create<ForkState>()((set) => ({
  activeForkId: null,

  setActiveFork: (id) => {
    set({ activeForkId: id });
  },
}));
