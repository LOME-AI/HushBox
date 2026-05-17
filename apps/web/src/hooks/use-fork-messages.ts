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

/**
 * Assistant siblings sharing a parentMessageId are always parallel
 * multi-model responses to the same user prompt. The product enforces this
 * invariant on the write side: regenerate is blocked for multi-model
 * messages (see `message-actions.ts`'s `regenerate` guard), and the
 * regenerate tree action deletes-and-replaces rather than appending
 * siblings (see `services/chat/tree-action.ts`). So an assistant sibling
 * cannot exist except as a parallel-batch peer, and it must travel with
 * its shared parent on every branch that includes the parent — regardless
 * of what other forks have grown beneath it.
 */
function isParallelBatchSibling(sibling: MessageWithParent): boolean {
  return sibling.role === 'assistant';
}

/**
 * Non-assistant siblings (user messages sharing a parentMessageId under an
 * assistant ancestor) represent divergent conversation threads — typically
 * the first message of a different fork. They're only safe to render on
 * this branch when their entire subtree is already in our ancestor chain;
 * otherwise the subtree belongs to a different fork and rendering the
 * sibling here would surface that fork's content.
 */
function isContainedThreadSibling(
  sibling: MessageWithParent,
  ancestorIds: Set<string>,
  childrenMap: Map<string | null, MessageWithParent[]>
): boolean {
  const children = childrenMap.get(sibling.id) ?? [];
  return children.every((c) => ancestorIds.has(c.id));
}

/**
 * Expand ancestor set to include siblings. Two distinct rules apply:
 *
 * - Parallel-batch siblings (assistant role): always included — they are
 *   multi-model peers of an ancestor and belong with the shared parent.
 * - Divergent-thread siblings (everything else): included only if their
 *   subtree is fully contained in the ancestor chain.
 *
 * Conflating the two used to silently drop a multi-model assistant peer
 * from its source branch as soon as another fork sent a follow-up beneath
 * it. Splitting the rule by role honors the write-side invariant that
 * regenerate cannot produce sibling assistants.
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
      if (included.has(sibling.id)) continue;
      if (
        isParallelBatchSibling(sibling) ||
        isContainedThreadSibling(sibling, ancestorIds, childrenMap)
      ) {
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
