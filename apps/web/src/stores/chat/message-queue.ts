import { create } from 'zustand';
import type { PayerSwitchReason } from '@hushbox/shared';

/**
 * A message the user composed while an AI run was streaming, held client-side
 * until the queue is drained one at a time. Persistence across navigation is
 * intended — the store never auto-clears.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /**
   * The payer-change sentence the composer was showing when this message was
   * accepted, or `undefined` when it was showing none. It rides on the message
   * because the drain re-resolves funding when it finally sends: without the
   * terms the user agreed to, a later send cannot tell a payer that changed
   * behind their back from one they were told about.
   */
  payerSwitch: PayerSwitchReason | undefined;
}

const MAX_QUEUED_PER_CONVERSATION = 5;

interface MessageQueueState {
  queuesByConversation: Record<string, QueuedMessage[]>;
  /**
   * Omitting `payerSwitch` records that no payer-change sentence was on screen,
   * which is also the safe reading of a caller that does not know: a message
   * carrying no disclosure is handed back rather than sent if the payer has
   * moved by the time it drains.
   */
  enqueue: (conversationId: string, text: string, payerSwitch?: PayerSwitchReason) => boolean;
  cancel: (conversationId: string, id: string) => void;
  dequeueHead: (conversationId: string) => QueuedMessage | undefined;
  clear: (conversationId: string) => void;
  queued: (conversationId: string) => QueuedMessage[];
  count: (conversationId: string) => number;
  isFull: (conversationId: string) => boolean;
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queuesByConversation: {},

  enqueue: (conversationId, text, payerSwitch) => {
    const current = get().queuesByConversation[conversationId] ?? [];
    if (current.length >= MAX_QUEUED_PER_CONVERSATION) return false;
    const message: QueuedMessage = { id: crypto.randomUUID(), text, payerSwitch };
    set((state) => ({
      queuesByConversation: {
        ...state.queuesByConversation,
        [conversationId]: [...(state.queuesByConversation[conversationId] ?? []), message],
      },
    }));
    return true;
  },

  cancel: (conversationId, id) => {
    set((state) => {
      const current = state.queuesByConversation[conversationId];
      if (!current) return state;
      const next = current.filter((message) => message.id !== id);
      if (next.length === current.length) return state;
      return {
        queuesByConversation: { ...state.queuesByConversation, [conversationId]: next },
      };
    });
  },

  dequeueHead: (conversationId) => {
    const current = get().queuesByConversation[conversationId] ?? [];
    if (current.length === 0) return;
    const [head, ...rest] = current;
    set((state) => ({
      queuesByConversation: { ...state.queuesByConversation, [conversationId]: rest },
    }));
    return head;
  },

  clear: (conversationId) => {
    set((state) => ({
      queuesByConversation: { ...state.queuesByConversation, [conversationId]: [] },
    }));
  },

  queued: (conversationId) => get().queuesByConversation[conversationId] ?? [],

  count: (conversationId) => (get().queuesByConversation[conversationId] ?? []).length,

  isFull: (conversationId) =>
    (get().queuesByConversation[conversationId] ?? []).length >= MAX_QUEUED_PER_CONVERSATION,
}));
