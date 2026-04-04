import { create } from 'zustand';

interface DecryptionActivityState {
  pendingDecryptions: number;
  markPending: () => void;
  markComplete: () => void;
}

export const useDecryptionActivityStore = create<DecryptionActivityState>()((set) => ({
  pendingDecryptions: 0,

  markPending: () => {
    set((state) => ({ pendingDecryptions: state.pendingDecryptions + 1 }));
  },

  markComplete: () => {
    set((state) => ({ pendingDecryptions: Math.max(0, state.pendingDecryptions - 1) }));
  },
}));
