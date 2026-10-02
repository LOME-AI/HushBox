import { create } from 'zustand';

interface RightPaneState {
  active: string | null;
  open: (id: string) => void;
  close: () => void;
}

/**
 * Which right pane is open, if any. One id at a time is what makes the slot hold one
 * pane: opening another replaces it. Never persisted, so a reload opens with none.
 */
export const useRightPane = create<RightPaneState>((set) => ({
  active: null,
  open: (id) => {
    set({ active: id });
  },
  close: () => {
    set({ active: null });
  },
}));
