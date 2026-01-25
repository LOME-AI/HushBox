import type { ChatMessage } from '../openrouter/types.js';

interface MessageWithRole {
  role: string;
  content: string;
}

/**
 * Validates that the last message in an array is from a user.
 * Returns false for empty arrays or when last message is not from user.
 *
 * @param messages - Array of messages to validate
 * @returns true if last message has role 'user', false otherwise
 */
export function validateLastMessageIsFromUser(messages: MessageWithRole[]): boolean {
  if (messages.length === 0) {
    return false;
  }
  const lastMessage = messages.at(-1);
  return lastMessage?.role === 'user';
}

/**
 * Builds OpenRouter-compatible message array with system prompt.
 * Prepends system prompt and maps messages to role/content pairs.
 *
 * @param systemPrompt - System prompt to prepend
 * @param messages - Array of chat messages
 * @returns Array of ChatMessage objects ready for OpenRouter API
 */
export function buildOpenRouterMessages(
  systemPrompt: string,
  messages: MessageWithRole[]
): ChatMessage[] {
  return [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((msg) => ({
      role: msg.role as ChatMessage['role'],
      content: msg.content,
    })),
  ];
}
