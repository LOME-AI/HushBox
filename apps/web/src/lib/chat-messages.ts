import type { Message } from '@/lib/api';
import type { GuestMessage } from '@/stores/guest-chat';

export function createUserMessage(conversationId: string, content: string): Message {
  return {
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
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

export function createGuestMessage(
  role: 'user' | 'assistant',
  content: string,
  id?: string
): GuestMessage {
  return {
    id: id ?? crypto.randomUUID(),
    conversationId: 'guest',
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export function appendTokenToMessage<T extends { id: string; content: string }>(
  messages: T[],
  messageId: string,
  token: string
): T[] {
  return messages.map((m) => (m.id === messageId ? { ...m, content: m.content + token } : m));
}
