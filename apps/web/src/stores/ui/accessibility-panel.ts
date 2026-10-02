import { create } from 'zustand';

interface AccessibilityPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the in-app accessibility panel is open; More options opens it, the panel's host reads it. */
export const useAccessibilityPanelStore = create<AccessibilityPanelState>((set) => ({
  open: false,
  setOpen: (open) => {
    set({ open });
  },
}));
