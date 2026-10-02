import { isOwnMessage, resolveSenderName } from './sender';
import type { LinkInfo } from './sender';
import type { Message } from '@/lib/api/api';

interface ReplyingToIdentity {
  currentUserId: string;
  isGroupChat: boolean;
  members: readonly { userId: string; username: string }[];
  links: readonly LinkInfo[];
}

/**
 * The one member a group reply answers: the sender of its parent user message,
 * named as the thread names senders, or "you" for the viewer's own message.
 * A departed or unresolvable sender gives nothing rather than the thread's
 * departed-sender label, which would read "replying to This user has left…".
 */
export function replyingToOf(
  message: Message,
  byId: ReadonlyMap<string, Message>,
  identity: Readonly<ReplyingToIdentity>
): string | undefined {
  const { currentUserId, isGroupChat, members, links } = identity;
  if (!isGroupChat || message.role !== 'assistant' || !message.parentMessageId) {
    return undefined;
  }

  const parent = byId.get(message.parentMessageId);
  if (parent?.role !== 'user') return undefined;

  const { senderId } = parent;
  if (senderId === undefined) return undefined;
  if (isOwnMessage(senderId, currentUserId)) return 'you';

  return resolveSenderName({ senderId, members, links });
}
