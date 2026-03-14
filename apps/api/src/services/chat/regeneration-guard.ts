import { eq, and, desc, isNull } from 'drizzle-orm';
import { messages, conversationMembers, type Database } from '@hushbox/db';

// ============================================================================
// Types
// ============================================================================

export interface CanRegenerateParams {
  conversationId: string;
  targetMessageId: string;
  userId: string;
  forkTipMessageId?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Checks whether a user can regenerate from a target message.
 *
 * - Solo chats: always returns true
 * - Group chats: walks from tip to target, checks if any user message
 *   between them (exclusive of target) has a different senderId
 *
 * If forkTipMessageId is not provided in a group chat, uses the message
 * with the highest sequence number as the tip.
 */
/** Resolves the effective tip message ID for regeneration checks. */
async function resolveTipMessageId(
  tx: Database,
  conversationId: string,
  forkTipMessageId?: string
): Promise<string | null> {
  if (forkTipMessageId) return forkTipMessageId;

  const [lastMsg] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sequenceNumber))
    .limit(1);

  return lastMsg?.id ?? null;
}

/** Walks from tip to target, returns false if a different user sent a message between them. */
function checkChainForOtherUsers(
  messageMap: Map<
    string,
    { id: string; parentMessageId: string | null; senderType: string; senderId: string | null }
  >,
  tipMessageId: string,
  targetMessageId: string,
  userId: string
): boolean {
  const visited = new Set<string>();
  let currentId: string | null = tipMessageId;

  while (currentId && currentId !== targetMessageId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const msg = messageMap.get(currentId);
    if (!msg) break;

    if (msg.senderType === 'user' && msg.senderId && msg.senderId !== userId) {
      return false;
    }

    currentId = msg.parentMessageId ?? null;
  }

  return true;
}

export async function canRegenerate(tx: Database, params: CanRegenerateParams): Promise<boolean> {
  // Check if this is a group chat (has more than one member)
  const members = await tx
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, params.conversationId),
        isNull(conversationMembers.leftAt)
      )
    );

  // Solo chat → always allowed
  if (members.length === 0) {
    return true;
  }

  // Group chat → resolve tip and check chain
  const tipMessageId = await resolveTipMessageId(
    tx,
    params.conversationId,
    params.forkTipMessageId
  );

  if (!tipMessageId || tipMessageId === params.targetMessageId) {
    return true;
  }

  const allMessages = await tx
    .select({
      id: messages.id,
      parentMessageId: messages.parentMessageId,
      senderType: messages.senderType,
      senderId: messages.senderId,
    })
    .from(messages)
    .where(eq(messages.conversationId, params.conversationId));

  const messageMap = new Map(allMessages.map((m) => [m.id, m]));

  return checkChainForOtherUsers(messageMap, tipMessageId, params.targetMessageId, params.userId);
}
