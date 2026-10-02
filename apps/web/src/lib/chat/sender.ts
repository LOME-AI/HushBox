import type { Message } from '@/lib/api/api';

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

export interface LinkInfo {
  id: string;
  displayName: string | null;
}

interface SenderLabelInput {
  senderId: string | undefined;
  currentUserId: string;
  members: readonly MemberInfo[];
  isGroupChat: boolean;
  links?: readonly LinkInfo[];
}

interface SenderNameInput {
  senderId: string;
  members: readonly MemberInfo[];
  links?: readonly LinkInfo[] | undefined;
}

/**
 * The name a conversation knows a sender by: a member's username, else a link's
 * name ("Guest" when unnamed). `undefined` means the sender is known to neither,
 * which is how a departed sender reads.
 */
export function resolveSenderName(input: SenderNameInput): string | undefined {
  const { senderId, members, links } = input;

  const member = members.find((m) => m.userId === senderId);
  if (member) {
    return member.username;
  }

  const link = links?.find((l) => l.id === senderId);
  if (link) {
    return link.displayName ?? 'Guest';
  }

  return undefined;
}

/**
 * Resolve a senderId to a display label for group chats.
 *
 * Checks members first (by userId), then links (by link id).
 * Returns undefined if not in a group chat or if senderId is absent.
 */
export function getSenderLabel(input: SenderLabelInput): string | undefined {
  const { senderId, currentUserId, members, isGroupChat, links } = input;

  if (!isGroupChat || senderId === undefined) {
    return undefined;
  }

  if (senderId === currentUserId) {
    return 'You';
  }

  return resolveSenderName({ senderId, members, links }) ?? 'This user has left the conversation';
}

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
