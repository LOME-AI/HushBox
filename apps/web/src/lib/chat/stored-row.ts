import type { Message } from '@/lib/api/api';

/**
 * A stored row is the only message carrying the wrapped content key, which arrives with
 * the history read; an optimistic, streaming or trial message has none.
 */
export function isStoredRow(message: Pick<Message, 'wrappedContentKey'>): boolean {
  return message.wrappedContentKey !== undefined;
}
