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

/**
 * Stable key used when the conversation has no active fork (linear chat) or
 * when the caller wants to address the Main branch. Components pass
 * `activeForkId ?? MAIN_FORK_KEY` when reading or writing.
 *
 * Prior to this change, the store held a single `error` slot. A regenerate
 * failure on Main would set that slot, then switching tabs to Fork 1 would
 * surface the error tile on Fork 1 because `mergeMessages` read the single
 * global slot. Per-fork keying isolates errors to the branch where they
 * originated.
 */
export const MAIN_FORK_KEY = 'main';

interface ChatErrorState {
  errorsByFork: Record<string, ChatErrorMessage | null>;
  getError: (forkKey: string) => ChatErrorMessage | null;
  setError: (forkKey: string, error: ChatErrorMessage) => void;
  clearError: (forkKey: string) => void;
  clearAll: () => void;
}

export const useChatErrorStore = create<ChatErrorState>()((set, get) => ({
  errorsByFork: {},

  getError: (forkKey) => get().errorsByFork[forkKey] ?? null,

  setError: (forkKey, error) => {
    set((state) => ({ errorsByFork: { ...state.errorsByFork, [forkKey]: error } }));
  },

  clearError: (forkKey) => {
    set((state) => {
      if (!(forkKey in state.errorsByFork)) return state;
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key to drop it from the new object
      const { [forkKey]: _removed, ...rest } = state.errorsByFork;
      return { errorsByFork: rest };
    });
  },

  clearAll: () => {
    set({ errorsByFork: {} });
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
