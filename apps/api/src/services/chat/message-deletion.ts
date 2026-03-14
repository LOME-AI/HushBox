import { eq, gt, and, inArray } from 'drizzle-orm';
import { messages, type Database } from '@hushbox/db';

// ============================================================================
// Types
// ============================================================================

export interface DeleteMessagesAfterAnchorParams {
  conversationId: string;
  anchorMessageId: string;
  forkTipMessageId?: string;
}

export interface DeleteMessagesAfterAnchorResult {
  deletedIds: string[];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Deletes messages after an anchor point.
 *
 * - No forks path (forkTipMessageId not provided):
 *   Deletes all messages with sequence_number > anchor's sequence_number
 *   in the same conversation.
 *
 * - Fork path (forkTipMessageId provided):
 *   Walks the parent chain from tip to anchor, collects candidates,
 *   checks for shared messages (those with children outside the candidate set),
 *   and deletes only non-shared candidates.
 *
 * Idempotent: re-running after deletion returns empty deletedIds.
 */
export async function deleteMessagesAfterAnchor(
  tx: Database,
  params: DeleteMessagesAfterAnchorParams
): Promise<DeleteMessagesAfterAnchorResult> {
  if (params.forkTipMessageId === undefined) {
    return deleteLinear(tx, params.conversationId, params.anchorMessageId);
  }
  return deleteForkChain(
    tx,
    params.conversationId,
    params.anchorMessageId,
    params.forkTipMessageId
  );
}

// ============================================================================
// No-fork (linear) deletion
// ============================================================================

async function deleteLinear(
  tx: Database,
  conversationId: string,
  anchorMessageId: string
): Promise<DeleteMessagesAfterAnchorResult> {
  // Get the anchor's sequence number
  const [anchor] = await tx
    .select({ sequenceNumber: messages.sequenceNumber })
    .from(messages)
    .where(eq(messages.id, anchorMessageId));

  if (!anchor) {
    return { deletedIds: [] };
  }

  const deleted = await tx
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.sequenceNumber, anchor.sequenceNumber)
      )
    )
    .returning({ id: messages.id });

  return { deletedIds: deleted.map((d) => d.id) };
}

// ============================================================================
// Fork-aware deletion
// ============================================================================

async function deleteForkChain(
  tx: Database,
  conversationId: string,
  anchorMessageId: string,
  forkTipMessageId: string
): Promise<DeleteMessagesAfterAnchorResult> {
  // If tip equals anchor, nothing to delete
  if (forkTipMessageId === anchorMessageId) {
    return { deletedIds: [] };
  }

  // Get all messages for this conversation to walk the chain
  const allMessages = await tx
    .select({
      id: messages.id,
      parentMessageId: messages.parentMessageId,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  const messageMap = new Map(allMessages.map((m) => [m.id, m]));

  // Walk from tip to anchor, collecting candidate IDs (excluding anchor)
  const candidates = new Set<string>();
  let currentId: string | null = forkTipMessageId;

  while (currentId && currentId !== anchorMessageId) {
    if (candidates.has(currentId)) break; // cycle protection
    candidates.add(currentId);
    const msg = messageMap.get(currentId);
    currentId = msg?.parentMessageId ?? null;
  }

  if (candidates.size === 0) {
    return { deletedIds: [] };
  }

  // Build a children map to check for shared messages
  const childrenMap = new Map<string, string[]>();
  for (const msg of allMessages) {
    if (msg.parentMessageId) {
      const children = childrenMap.get(msg.parentMessageId) ?? [];
      children.push(msg.id);
      childrenMap.set(msg.parentMessageId, children);
    }
  }

  // A candidate is shared if it has children outside the candidate set
  const toDelete: string[] = [];
  for (const candidateId of candidates) {
    const children = childrenMap.get(candidateId) ?? [];
    const hasExternalChild = children.some((childId) => !candidates.has(childId));
    if (!hasExternalChild) {
      toDelete.push(candidateId);
    }
  }

  if (toDelete.length === 0) {
    return { deletedIds: [] };
  }

  // Delete the non-shared candidates
  await tx.delete(messages).where(inArray(messages.id, toDelete));

  return { deletedIds: toDelete };
}
