import type * as React from 'react';
import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { BranchSwitcherProps } from '@/components/chat/layout/branch-switcher';
import type { ChatLayoutProps, GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { MemberSidebar } from '@/components/chat/member/member-sidebar';
import type { Message, MessageMediaItem } from '@/lib/api/api';

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

interface SharedMessageFields {
  sharedMessageContent: string | null;
  sharedMessageEpochNumber: number | null;
  sharedMessageWrappedContentKey: string | null;
  sharedMessageMediaItems: MessageMediaItem[] | null;
  // '' stands in for a null/scrubbed sender so the share-dialog media preview
  // can reconstruct the envelope; a write always binds a real sender (a user id
  // or the assistant constant), so that stand-in deliberately matches nothing.
  sharedMessageSenderId: string;
  // A share link publishes the rung the turn ran at and the reasoning volume it
  // was billed for, so the consent preview has to be able to show both.
  sharedMessageReasoningTokens: number | null;
  sharedMessageReasoningEffort: ResolvedReasoningEffort | null;
}

interface ChatLayoutDerivedState extends SharedMessageFields {
  premiumIds: Set<string>;
}

function findSharedMessage(messages: Message[], shareMessageId: string | null): Message | null {
  if (!shareMessageId) return null;
  return messages.find((m) => m.id === shareMessageId) ?? null;
}

function deriveSharedMessageFields(sharedMessage: Message | null): SharedMessageFields {
  if (sharedMessage === null) {
    return {
      sharedMessageContent: null,
      sharedMessageEpochNumber: null,
      sharedMessageWrappedContentKey: null,
      sharedMessageMediaItems: null,
      sharedMessageSenderId: '',
      sharedMessageReasoningTokens: null,
      sharedMessageReasoningEffort: null,
    };
  }
  return {
    // The raw text travels, delimiter included. A share link publishes the
    // reasoning half, so stripping it here would hide from the author the one
    // thing the consent screen exists to show; the preview parses it at the
    // display surface, the same field the public share page parses.
    sharedMessageContent: sharedMessage.content,
    sharedMessageEpochNumber: sharedMessage.epochNumber ?? null,
    sharedMessageWrappedContentKey: sharedMessage.wrappedContentKey ?? null,
    sharedMessageMediaItems: sharedMessage.mediaItems ?? null,
    sharedMessageSenderId: sharedMessage.senderId ?? '',
    sharedMessageReasoningTokens: sharedMessage.reasoningTokens ?? null,
    sharedMessageReasoningEffort: sharedMessage.reasoningEffort ?? null,
  };
}

export function resolveChatLayoutDerivedState(
  input: ChatLayoutDerivedInput
): ChatLayoutDerivedState {
  const sharedMessage = findSharedMessage(input.messages, input.shareMessageId);
  return {
    premiumIds: input.premiumIds,
    ...deriveSharedMessageFields(sharedMessage),
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
