import type { Message } from '@/lib/api/api';
import type { TrialMessage } from '@/stores/chat/trial-chat';

export function createUserMessage(
  conversationId: string,
  content: string,
  senderId: string | undefined,
  parentMessageId: string | null
): Message {
  return {
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    ...(senderId !== undefined && { senderId }),
    parentMessageId,
  };
}

/**
 * An optimistic user row re-keyed to the id the server stores it under. The row
 * is created under a local key, because the server mints the id and names it
 * only on the run-start response.
 */
export function adoptServerMessageId(message: Message, serverId: string): Message {
  return { ...message, id: serverId };
}

/**
 * The list with the row under `currentId` (its local key, or the id an earlier
 * run start named) re-keyed to the server's id and every row parented to it
 * moved onto that id; every other row untouched.
 */
export function adoptServerMessageIdIn(
  messages: readonly Message[],
  currentId: string,
  serverId: string
): Message[] {
  return messages.map((m) => {
    if (m.id === currentId) return adoptServerMessageId(m, serverId);
    if (m.parentMessageId === currentId) return { ...m, parentMessageId: serverId };
    return m;
  });
}

export function createAssistantMessage(
  conversationId: string,
  assistantMessageId: string,
  modelName: string | undefined,
  parentMessageId: string | null
): Message {
  return {
    id: assistantMessageId,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    ...(modelName !== undefined && { modelName }),
    parentMessageId,
  };
}

export function createTrialMessage(
  role: 'user' | 'assistant',
  content: string,
  id?: string,
  modelName?: string
): TrialMessage {
  return {
    id: id ?? crypto.randomUUID(),
    conversationId: 'trial',
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(modelName !== undefined && { modelName }),
  };
}
