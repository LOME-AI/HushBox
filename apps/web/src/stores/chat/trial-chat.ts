import { create } from 'zustand';

export interface TrialMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  modelName?: string;
  /**
   * Real model name the Smart Model classifier resolved, taken from the answer
   * stream's `stream-start` label. Used as the nametag's immediate display
   * value, mirroring the authenticated message shape.
   */
  resolvedModelName?: string;
  isSmartModel?: boolean;
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
  /**
   * Record a Smart Model tile's classifier-resolved model. Only ever called
   * for a Smart Model send, so it also lights the "Smart" chip.
   */
  setMessageSmartModelResolved: (
    messageId: string,
    resolution: { resolvedModelId: string; resolvedModelName: string }
  ) => void;
  /** Set the pending first message */
  setPendingMessage: (message: string | null) => void;
  /** Clear the pending message */
  clearPendingMessage: () => void;
  /** Set rate limited state */
  setRateLimited: (limited: boolean) => void;
  /** Remove all messages after the given message ID (keeps the target) */
  removeMessagesAfter: (messageId: string) => void;
  /** Drop a single message by id; no-op if not present */
  removeMessage: (messageId: string) => void;
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
  setMessageSmartModelResolved: (messageId, resolution) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              // Record the resolved id (so the nametag resolves like an authed
              // message) and the resolved name (immediate display fallback).
              modelName: resolution.resolvedModelId,
              resolvedModelName: resolution.resolvedModelName,
              isSmartModel: true,
            }
          : m
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
  removeMessagesAfter: (messageId) => {
    set((state) => {
      const index = state.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return state;
      return { messages: state.messages.slice(0, index + 1) };
    });
  },
  removeMessage: (messageId) => {
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }));
  },
  reset: () => {
    set({ messages: [], pendingMessage: null, isRateLimited: false });
  },
}));
