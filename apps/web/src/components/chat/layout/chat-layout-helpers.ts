import { publishedReplyOf } from '@/components/chat/message/share-message-modal';
import type * as React from 'react';
import type { BranchSwitcherProps } from '@/components/chat/layout/branch-switcher';
import type { ChatLayoutProps, GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { MemberSidebar } from '@/components/chat/member/member-sidebar';
import type { ShareMessageReply } from '@/components/chat/message/share-message-modal';
import type { Message } from '@/lib/api/api';

interface MobileInputStyleInput {
  readonly isMobile: boolean;
  readonly keyboardOffset: number;
  readonly isKeyboardVisible: boolean;
}

export function getMobileInputStyle(input: MobileInputStyleInput): React.CSSProperties | undefined {
  if (!input.isMobile) return undefined;
  return {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: `${String(input.keyboardOffset)}px`,
    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
    transition: input.isKeyboardVisible ? 'none' : 'bottom 0.2s ease-out',
    zIndex: 10,
  };
}

export function getContentAreaStyle(
  isMobile: boolean,
  inputHeight: number
): React.CSSProperties | undefined {
  if (isMobile && inputHeight > 0) return { marginBottom: inputHeight };
  return undefined;
}

interface WebSocketAttributes {
  wsConnected: string | undefined;
  wsReady: string | undefined;
}

export function getWebSocketAttributes(
  ws: { connected: boolean; ready: boolean } | undefined
): WebSocketAttributes {
  return {
    wsConnected: ws?.connected === true ? 'true' : undefined,
    wsReady: ws?.ready === true ? 'true' : undefined,
  };
}

interface ChatLayoutDerivedInput {
  readonly premiumIds: Set<string>;
  readonly shareMessageId: string | null;
  readonly messages: Message[];
}

interface ChatLayoutDerivedState {
  premiumIds: Set<string>;
  /** The reply the share dialog previews, or null while none is selected or found. */
  sharedMessage: ShareMessageReply | null;
}

function findSharedMessage(messages: Message[], shareMessageId: string | null): Message | null {
  if (!shareMessageId) return null;
  return messages.find((m) => m.id === shareMessageId) ?? null;
}

/** The published projection of the selected message: the share dialog never holds the rest. */
function sharedReplyOf(message: Message | null): ShareMessageReply | null {
  return message === null ? null : publishedReplyOf(message);
}

export function resolveChatLayoutDerivedState(
  input: ChatLayoutDerivedInput
): ChatLayoutDerivedState {
  return {
    premiumIds: input.premiumIds,
    sharedMessage: sharedReplyOf(findSharedMessage(input.messages, input.shareMessageId)),
  };
}

export function buildMemberSidebarProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MemberSidebar>> {
  if (groupChat === undefined) return {};
  return {
    members: groupChat.members,
    links: groupChat.links,
    onlineMemberIds: groupChat.onlineMemberIds,
    currentUserId: groupChat.currentUserId,
    currentUserLinkId: groupChat.currentUserLinkId ?? null,
    currentUserPrivilege: groupChat.currentUserPrivilege,
    ...(groupChat.onRemoveMember !== undefined && {
      onRemoveMember: groupChat.onRemoveMember,
    }),
    ...(groupChat.onChangePrivilege !== undefined && {
      onChangePrivilege: groupChat.onChangePrivilege,
    }),
    ...(groupChat.onRevokeLinkClick !== undefined && {
      onRevokeLinkClick: groupChat.onRevokeLinkClick,
    }),
    ...(groupChat.onSaveLinkName !== undefined && {
      onSaveLinkName: groupChat.onSaveLinkName,
    }),
    ...(groupChat.onChangeLinkPrivilege !== undefined && {
      onChangeLinkPrivilege: groupChat.onChangeLinkPrivilege,
    }),
    ...(groupChat.onLeave !== undefined && { onLeaveClick: groupChat.onLeave }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for noop fallback
const NOOP = (): void => {};

type BranchSwitcherHandlers = Pick<
  BranchSwitcherProps,
  'currentForkId' | 'onSelect' | 'onRename' | 'onDelete'
>;

interface BranchSwitcherHandlersInput {
  activeForkId: ChatLayoutProps['activeForkId'];
  onForkSelect: ChatLayoutProps['onForkSelect'];
  onForkRename: ChatLayoutProps['onForkRename'];
  onForkDelete: ChatLayoutProps['onForkDelete'];
}

export function resolveBranchSwitcherHandlers(
  input: BranchSwitcherHandlersInput
): BranchSwitcherHandlers {
  return {
    currentForkId: input.activeForkId ?? null,
    onSelect: input.onForkSelect ?? NOOP,
    onRename: input.onForkRename ?? NOOP,
    onDelete: input.onForkDelete ?? NOOP,
  };
}
