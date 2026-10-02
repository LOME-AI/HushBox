import { create } from 'zustand';

interface TouchOverrideState {
  override: boolean | null;
  toggle: () => void;
}

export const useTouchOverrideStore = create<TouchOverrideState>((set) => ({
  override: null,
  toggle: () => {
    set((state) => ({ override: state.override === true ? null : true }));
  },
}));
