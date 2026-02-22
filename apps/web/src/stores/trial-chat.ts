import { create } from 'zustand';

export interface TrialMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface TrialChatState {
  /** All trial messages in the current session */
  messages: TrialMessage[];
  /** The first message that triggered navigation to /chat/trial */
  pendingMessage: string | null;
  /** Whether the user has hit the rate limit */
  isRateLimited: boolean;
  /** Add a message to the conversation */
  addMessage: (message: TrialMessage) => void;
  /** Update a message's content (for streaming) */
  updateMessageContent: (messageId: string, content: string) => void;
  /** Append content to a message (for streaming tokens) */
  appendToMessage: (messageId: string, token: string) => void;
  /** Set the pending first message */
  setPendingMessage: (message: string | null) => void;
  /** Clear the pending message */
  clearPendingMessage: () => void;
  /** Set rate limited state */
  setRateLimited: (limited: boolean) => void;
  /** Clear all trial messages and reset state */
  reset: () => void;
}

export const useTrialChatStore = create<TrialChatState>((set) => ({
  messages: [],
  pendingMessage: null,
  isRateLimited: false,
  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },
  updateMessageContent: (messageId, content) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
    }));
  },
  appendToMessage: (messageId, token) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + token } : m
      ),
    }));
  },
  setPendingMessage: (message) => {
    set({ pendingMessage: message });
  },
  clearPendingMessage: () => {
    set({ pendingMessage: null });
  },
  setRateLimited: (limited) => {
    set({ isRateLimited: limited });
  },
  reset: () => {
    set({ messages: [], pendingMessage: null, isRateLimited: false });
  },
}));
