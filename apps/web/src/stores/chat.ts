import { create } from 'zustand';

interface PendingMessage {
  id: string;
  content: string;
  createdAt: Date;
}

interface ChatState {
  pendingMessages: Record<string, PendingMessage[]>;
  addPendingMessage: (conversationId: string, content: string) => string;
  removePendingMessage: (conversationId: string, id: string) => void;
  clearPendingMessages: (conversationId: string) => void;

  streamingContent: string | null;
  setStreamingContent: (content: string | null) => void;
  appendStreamingContent: (chunk: string) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  pendingMessages: {},

  addPendingMessage: (conversationId, content) => {
    const id = crypto.randomUUID();
    const message: PendingMessage = { id, content, createdAt: new Date() };
    set((state) => ({
      pendingMessages: {
        ...state.pendingMessages,
        [conversationId]: [...(state.pendingMessages[conversationId] ?? []), message],
      },
    }));
    return id;
  },

  removePendingMessage: (conversationId, id) => {
    set((state) => ({
      pendingMessages: {
        ...state.pendingMessages,
        [conversationId]: (state.pendingMessages[conversationId] ?? []).filter((m) => m.id !== id),
      },
    }));
  },

  clearPendingMessages: (conversationId) => {
    set((state) => ({
      pendingMessages: Object.fromEntries(
        Object.entries(state.pendingMessages).filter(([key]) => key !== conversationId)
      ),
    }));
  },

  streamingContent: null,
  setStreamingContent: (content) => {
    set({ streamingContent: content });
  },
  appendStreamingContent: (chunk) => {
    set((state) => ({
      streamingContent: (state.streamingContent ?? '') + chunk,
    }));
  },
}));
