import { create } from 'zustand';
import type { UserFacingMessage } from '@hushbox/shared';

export interface ChatErrorMessage {
  id: string;
  content: string;
  retryable: boolean;
  failedUserMessage: {
    id: string;
    content: string;
  };
}

interface ChatErrorState {
  error: ChatErrorMessage | null;
  setError: (error: ChatErrorMessage) => void;
  clearError: () => void;
}

export const useChatErrorStore = create<ChatErrorState>()((set) => ({
  error: null,

  setError: (error) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },
}));

export function createChatError(params: {
  content: UserFacingMessage;
  retryable: boolean;
  failedContent: string;
}): ChatErrorMessage {
  return {
    id: crypto.randomUUID(),
    content: params.content,
    retryable: params.retryable,
    failedUserMessage: {
      id: crypto.randomUUID(),
      content: params.failedContent,
    },
  };
}
