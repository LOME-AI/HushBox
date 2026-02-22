import type { Message } from '@/lib/api';
import type { TrialMessage } from '@/stores/trial-chat';

export function createUserMessage(
  conversationId: string,
  content: string,
  senderId?: string
): Message {
  return {
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    ...(senderId !== undefined && { senderId }),
  };
}

export function createAssistantMessage(
  conversationId: string,
  assistantMessageId: string
): Message {
  return {
    id: assistantMessageId,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
  };
}

export function createTrialMessage(
  role: 'user' | 'assistant',
  content: string,
  id?: string
): TrialMessage {
  return {
    id: id ?? crypto.randomUUID(),
    conversationId: 'trial',
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export interface ChatErrorDisplay {
  id: string;
  role: 'assistant';
  content: string;
  retryable: boolean;
  isError: true;
}

export function appendTokenToMessage<T extends { id: string; content: string }>(
  messages: T[],
  messageId: string,
  token: string
): T[] {
  return messages.map((m) => (m.id === messageId ? { ...m, content: m.content + token } : m));
}
