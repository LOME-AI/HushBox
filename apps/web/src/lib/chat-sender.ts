import type { Message } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageGroup {
  /** First message's id — used as stable Virtuoso key */
  id: string;
  role: 'user' | 'assistant';
  senderId?: string;
  messages: Message[];
}

interface MemberInfo {
  userId: string;
  username: string;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Resolve a senderId to a display label for group chats.
 *
 * Returns undefined if not in a group chat or if senderId is absent.
 */
export function getSenderLabel(
  senderId: string | undefined,
  currentUserId: string,
  members: readonly MemberInfo[],
  isGroupChat: boolean
): string | undefined {
  if (!isGroupChat || senderId === undefined) {
    return undefined;
  }

  if (senderId === currentUserId) {
    return 'You';
  }

  const member = members.find((m) => m.userId === senderId);
  if (member) {
    return member.username;
  }

  return 'This user has left the conversation';
}

/**
 * Check if a message was sent by the current user.
 */
export function isOwnMessage(senderId: string | undefined, currentUserId: string): boolean {
  return senderId !== undefined && senderId === currentUserId;
}

/**
 * Group consecutive user messages with the same senderId into MessageGroups.
 *
 * Rules:
 * - AI messages (role: 'assistant') are never grouped — always standalone
 * - User messages without senderId are never grouped — always standalone
 * - Consecutive user messages with the same senderId merge into one group
 */
export function groupConsecutiveMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const msg of messages) {
    const canGroup = msg.role === 'user' && msg.senderId !== undefined;

    if (canGroup && groups.length > 0) {
      const lastGroup = groups.at(-1);
      if (lastGroup?.role === 'user' && lastGroup.senderId === msg.senderId) {
        lastGroup.messages.push(msg);
        continue;
      }
    }

    groups.push({
      id: msg.id,
      role: msg.role,
      ...(msg.senderId !== undefined && { senderId: msg.senderId }),
      messages: [msg],
    });
  }

  return groups;
}
