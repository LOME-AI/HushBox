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

/** Walk tip → root via parentMessageId, collecting ancestor IDs. */
function collectAncestorIds(
  tipMessage: MessageWithParent,
  messageMap: Map<string, MessageWithParent>
): Set<string> {
  const ancestorIds = new Set<string>();
  const visited = new Set<string>();
  let current: MessageWithParent | undefined = tipMessage;

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    ancestorIds.add(current.id);
    const parentId: string | null | undefined = current.parentMessageId;
    current = parentId ? messageMap.get(parentId) : undefined;
  }

  return ancestorIds;
}

/** Returns true if a sibling message is safe to include (no descendants outside the ancestor chain). */
function isSafeSibling(
  sibling: MessageWithParent,
  ancestorIds: Set<string>,
  childrenMap: Map<string | null, MessageWithParent[]>
): boolean {
  const children = childrenMap.get(sibling.id) ?? [];
  return children.every((c) => ancestorIds.has(c.id));
}

/**
 * Expand ancestor set to include multi-model siblings — messages sharing a
 * parentMessageId with a chain member that are NOT fork branch roots.
 */
function expandWithSiblings(
  ancestorIds: Set<string>,
  messageMap: Map<string, MessageWithParent>,
  childrenMap: Map<string | null, MessageWithParent[]>
): Set<string> {
  const included = new Set<string>(ancestorIds);
  for (const id of ancestorIds) {
    const msg = messageMap.get(id);
    const parentId = msg?.parentMessageId;
    if (parentId === undefined) continue;
    const siblings = childrenMap.get(parentId ?? null) ?? [];
    for (const sibling of siblings) {
      if (!included.has(sibling.id) && isSafeSibling(sibling, ancestorIds, childrenMap)) {
        included.add(sibling.id);
      }
    }
  }
  return included;
}

/**
 * Walk from the tip message to the root via parentMessageId, then expand each
 * chain node to include sibling messages (multi-model responses that share the
 * same parentMessageId). Returns messages sorted by their original array order.
 */
function walkParentChainWithSiblings(
  tipMessage: MessageWithParent,
  messageMap: Map<string, MessageWithParent>,
  childrenMap: Map<string | null, MessageWithParent[]>,
  allMessages: MessageWithParent[]
): MessageWithParent[] {
  const ancestorIds = collectAncestorIds(tipMessage, messageMap);
  const included = expandWithSiblings(ancestorIds, messageMap, childrenMap);
  return allMessages.filter((m) => included.has(m.id));
}

/**
 * Filters messages for the active fork by walking the parent chain from the fork's tip.
 *
 * - No forks → return messages sorted by creation order (sequenceNumber proxy via array index)
 * - With forks → build chain from tip to root, expand to include sibling messages
 *   (multi-model responses sharing the same parentMessageId), preserve original order
 *
 * Pure function extracted for testing.
 */
/** Build parentId → children[] lookup map. */
function buildChildrenMap(messages: MessageWithParent[]): Map<string | null, MessageWithParent[]> {
  const childrenMap = new Map<string | null, MessageWithParent[]>();
  for (const msg of messages) {
    const pid = msg.parentMessageId ?? null;
    const array = childrenMap.get(pid);
    if (array) {
      array.push(msg);
    } else {
      childrenMap.set(pid, [msg]);
    }
  }
  return childrenMap;
}

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

  const childrenMap = buildChildrenMap(allMessages);
  return walkParentChainWithSiblings(tipMessage, messageMap, childrenMap, allMessages);
}

/**
 * React hook that memoizes fork-filtered messages.
 *
 * - No forks → returns messages as-is (sorted by sequenceNumber)
 * - With forks → builds chain from tip to root for the active fork, includes siblings
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
