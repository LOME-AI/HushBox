import { create } from 'zustand';

interface ChatEditState {
  editingMessageId: string | null;
  editingContent: string;

  startEditing: (messageId: string, content: string) => void;
  clearEditing: () => void;
}

export const useChatEditStore = create<ChatEditState>()((set) => ({
  editingMessageId: null,
  editingContent: '',

  startEditing: (messageId, content) => {
    set({ editingMessageId: messageId, editingContent: content });
  },

  clearEditing: () => {
    set({ editingMessageId: null, editingContent: '' });
  },
}));
