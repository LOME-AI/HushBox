import { cn } from '@hushbox/ui';
import { getSenderLabel, isOwnMessage } from '@/lib/chat/sender';
import type { MessageBodyVariant } from '@/components/chat/message/message-body';
import type { MessageGroup, LinkInfo } from '@/lib/chat/sender';
import type { Message } from '@/lib/api/api';

export interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

export function computeContainerClasses(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): string {
  // The chat column carries the gutters, so no row insets itself. A reply closes
  // its turn and leaves more room below it than a message leaves before its reply.
  if (!isUser) {
    return cn('pt-1.5 pb-7.5', 'w-full');
  }
  if (isGroupedUser && !ownMessage) {
    return cn('pt-1.5 pb-3.5', 'mr-auto w-fit max-w-[82%]');
  }
  return cn('pt-1.5 pb-3.5', 'ml-auto w-fit max-w-[82%]');
}

export function computeBubbleVariant(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): MessageBodyVariant {
  if (!isUser) return 'assistant';
  if (isGroupedUser && !ownMessage) return 'user-other';
  return 'user-own';
}

export interface MessageDisplayState {
  isGroupedUser: boolean;
  effectiveRole: string;
  isUser: boolean;
  senderLabel: string | undefined;
  ownMessage: boolean;
  messagesToRender: Message[];
  primaryMessage: Message;
}

interface MessageDisplayInput {
  message: Message;
  group: MessageGroup | undefined;
  isGroupChat: boolean | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
  links: LinkInfo[] | undefined;
}

interface GroupIdentityInput {
  isGroupedUser: boolean;
  group: MessageGroup | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
  links: LinkInfo[] | undefined;
}

function resolveGroupIdentity(input: GroupIdentityInput): {
  senderLabel: string | undefined;
  ownMessage: boolean;
} {
  const { isGroupedUser, group, currentUserId, members, links } = input;
  if (!isGroupedUser || !currentUserId || !group) {
    return { senderLabel: undefined, ownMessage: true };
  }
  return {
    senderLabel: getSenderLabel({
      senderId: group.senderId,
      currentUserId,
      members: members ?? [],
      isGroupChat: true,
      links: links ?? [],
    }),
    ownMessage: isOwnMessage(group.senderId, currentUserId),
  };
}

export function computeMessageDisplayState(input: MessageDisplayInput): MessageDisplayState {
  const { message, group, isGroupChat, currentUserId, members, links } = input;
  const isGroupedUser = !!group && group.role === 'user' && !!isGroupChat;
  const effectiveRole = group ? group.role : message.role;
  const isUser = effectiveRole === 'user';
  const { senderLabel, ownMessage } = resolveGroupIdentity({
    isGroupedUser,
    group,
    currentUserId,
    members,
    links,
  });
  const messagesToRender = isGroupedUser ? group.messages : [message];
  const primaryMessage = messagesToRender[0] ?? message;
  return {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  };
}
