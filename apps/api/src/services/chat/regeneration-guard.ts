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

  // Solo chat (no members in conversationMembers table) → always allowed
  // The conversation owner is stored in conversations.userId, not in conversationMembers.
  // Any entry in conversationMembers means other users have been added → group chat.
  if (members.length === 0) {
    return true;
  }

  // Group chat → need to check the chain
  let tipMessageId = params.forkTipMessageId;

  if (!tipMessageId) {
    // Find the message with the highest sequence number
    const [lastMsg] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, params.conversationId))
      .orderBy(desc(messages.sequenceNumber))
      .limit(1);

    if (!lastMsg) return true;
    tipMessageId = lastMsg.id;
  }

  // If target is the tip, no messages between them
  if (tipMessageId === params.targetMessageId) {
    return true;
  }

  // Get all messages to walk the chain
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

  // Walk from tip toward target, checking user messages
  const visited = new Set<string>();
  let currentId: string | null = tipMessageId;

  while (currentId && currentId !== params.targetMessageId) {
    if (visited.has(currentId)) break; // cycle protection
    visited.add(currentId);

    const msg = messageMap.get(currentId);
    if (!msg) break;

    // Check if this is a user message from a different user
    if (msg.senderType === 'user' && msg.senderId && msg.senderId !== params.userId) {
      return false;
    }

    currentId = msg.parentMessageId ?? null;
  }

  return true;
}
