import { create } from 'zustand';

interface PendingChatState {
  pendingMessage: string | null;
  setPendingMessage: (message: string | null) => void;
  clearPendingMessage: () => void;
}

export const usePendingChatStore = create<PendingChatState>((set) => ({
  pendingMessage: null,
  setPendingMessage: (message) => {
    set({ pendingMessage: message });
  },
  clearPendingMessage: () => {
    set({ pendingMessage: null });
  },
}));
