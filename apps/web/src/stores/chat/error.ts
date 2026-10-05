import { create } from 'zustand';
import type { TurnNotice } from '@/lib/chat/turn-notice';
import type {
  AuthenticatedStreamRequest,
  RegenerateStreamRequest,
} from '@/hooks/chat/use-chat-stream';
import type { Message } from '@/lib/api/api';

/**
 * A failed turn's retry handle: the exact request it posted and the turn object
 * its Idempotency-Key was minted from, so a retry re-posts that turn under its own
 * key and the server's key row decides whether it replays, attaches or re-runs.
 * `question` is the row the thread draws for the question when no row shows it:
 * a send's question, an edit's edited question, and none for a retry, whose
 * question is its stored anchor.
 */
export type FailedTurnRetry =
  | { kind: 'send'; request: AuthenticatedStreamRequest; turn: object; question: Message }
  | {
      kind: 'regenerate';
      request: RegenerateStreamRequest;
      turn: object;
      question: Message | null;
    };

export interface FailedTurn {
  retry: FailedTurnRetry;
  /** The ids the turn's own stored rows carry if it settled; any one of them stored means it did. */
  storedIds: readonly string[];
}

interface ChatErrorMessage {
  id: string;
  notice: TurnNotice;
  failedUserMessage: {
    id: string;
    content: string;
  };
  failedTurn?: FailedTurn;
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
  notice: TurnNotice;
  failedContent: string;
  failedTurn?: FailedTurn;
}): ChatErrorMessage {
  return {
    id: crypto.randomUUID(),
    notice: params.notice,
    failedUserMessage: {
      id: crypto.randomUUID(),
      content: params.failedContent,
    },
    ...(params.failedTurn !== undefined && { failedTurn: params.failedTurn }),
  };
}
