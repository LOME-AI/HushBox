import { useMemo } from 'react';
import type { Message } from '../lib/api.js';

interface Fork {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

type MessageWithParent = Message & { parentMessageId?: string | null };

function walkParentChain(
  tipMessage: MessageWithParent,
  messageMap: Map<string, MessageWithParent>
): MessageWithParent[] {
  const chain: MessageWithParent[] = [];
  const visited = new Set<string>();
  let current: MessageWithParent | undefined = tipMessage;

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    chain.push(current);
    const parentId: string | null | undefined = current.parentMessageId;
    current = parentId ? messageMap.get(parentId) : undefined;
  }

  chain.reverse();
  return chain;
}

/**
 * Filters messages for the active fork by walking the parent chain from the fork's tip.
 *
 * - No forks → return messages sorted by creation order (sequenceNumber proxy via array index)
 * - With forks → build Map<id, Message>, walk from tip to root via parentMessageId, reverse
 *
 * Pure function extracted for testing.
 */
export function filterMessagesForFork(
  allMessages: MessageWithParent[],
  forks: Fork[],
  activeForkId: string | null
): MessageWithParent[] {
  if (allMessages.length === 0) return [];

  if (forks.length === 0 || activeForkId === null) {
    return [...allMessages];
  }

  const activeFork = forks.find((f) => f.id === activeForkId);
  if (!activeFork?.tipMessageId) return [...allMessages];

  const messageMap = new Map<string, MessageWithParent>();
  for (const msg of allMessages) {
    messageMap.set(msg.id, msg);
  }

  const tipMessage = messageMap.get(activeFork.tipMessageId);
  if (!tipMessage) return [...allMessages];

  return walkParentChain(tipMessage, messageMap);
}

/**
 * React hook that memoizes fork-filtered messages.
 *
 * - No forks → returns messages as-is (sorted by sequenceNumber)
 * - With forks → builds chain from tip to root for the active fork
 */
export function useForkMessages(
  allMessages: MessageWithParent[],
  forks: Fork[],
  activeForkId: string | null
): MessageWithParent[] {
  return useMemo(
    () => filterMessagesForFork(allMessages, forks, activeForkId),
    [allMessages, forks, activeForkId]
  );
}
