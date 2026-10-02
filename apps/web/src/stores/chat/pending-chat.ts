import { create } from 'zustand';
import type { FundingSource } from '@hushbox/shared';

interface PendingChatState {
  pendingMessage: string | null;
  pendingFundingSource: FundingSource | null;
  setPendingMessage: (message: string, fundingSource: FundingSource) => void;
  clearPendingMessage: () => void;
}

export const usePendingChatStore = create<PendingChatState>((set) => ({
  pendingMessage: null,
  pendingFundingSource: null,
  setPendingMessage: (message, fundingSource) => {
    set({ pendingMessage: message, pendingFundingSource: fundingSource });
  },
  clearPendingMessage: () => {
    set({ pendingMessage: null, pendingFundingSource: null });
  },
}));
