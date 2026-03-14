import type { MemberPrivilege } from '@hushbox/shared';
import type { Message } from './api.js';

/** Every possible action button on a message */
export type MessageAction =
  | 'copy'
  | 'regenerate'
  | 'retry'
  | 'edit'
  | 'fork'
  | 'share'
  | 'retry-error';

type ChatMode = 'solo' | 'group' | 'trial' | 'link-guest';

/** Distilled chat context for action resolution. Built once per render, not per-message. */
export interface ChatContext {
  mode: ChatMode;
  privilege: MemberPrivilege | undefined;
  currentUserId: string | undefined;
  isGroupChat: boolean;
}

/** Per-message information needed for action resolution. */
export interface MessageContext {
  message: Message;
  isStreaming: boolean;
  isError: boolean;
  isMultiModel: boolean;
  canRegenerate: boolean;
}

/**
 * Static base permissions: maximum set of actions per mode + privilege.
 * Dynamic guards further restrict these.
 */
const BASE_PERMISSIONS: Record<
  ChatMode,
  Partial<Record<MemberPrivilege | 'none', readonly MessageAction[]>>
> = {
  solo: {
    owner: ['copy', 'regenerate', 'retry', 'edit', 'fork', 'share', 'retry-error'],
  },
  group: {
    owner: ['copy', 'regenerate', 'retry', 'edit', 'fork', 'share', 'retry-error'],
    admin: ['copy', 'regenerate', 'retry', 'edit', 'fork', 'share', 'retry-error'],
    write: ['copy', 'regenerate', 'retry', 'edit', 'fork', 'share', 'retry-error'],
    read: ['copy'],
  },
  trial: {
    none: ['copy', 'retry', 'regenerate'],
  },
  'link-guest': {
    write: ['copy', 'regenerate', 'retry', 'edit', 'fork', 'retry-error'],
    read: ['copy'],
  },
};

/**
 * Per-action dynamic guards. If a guard returns false, the action is removed
 * even if BASE_PERMISSIONS allows it. Actions not listed here pass unconditionally.
 */
const ACTION_GUARDS: Partial<
  Record<MessageAction, (chat: ChatContext, msg: MessageContext) => boolean>
> = {
  copy: (_chat, msg) => !msg.isStreaming && !msg.isError,
  regenerate: (_chat, msg) =>
    msg.message.role === 'assistant' &&
    !msg.isStreaming &&
    !msg.isError &&
    !msg.isMultiModel &&
    msg.canRegenerate,
  retry: (_chat, msg) =>
    msg.message.role === 'user' &&
    !msg.isStreaming &&
    !msg.isError &&
    !msg.isMultiModel &&
    msg.canRegenerate,
  edit: (_chat, msg) =>
    msg.message.role === 'user' &&
    !msg.isStreaming &&
    !msg.isError &&
    !msg.isMultiModel &&
    msg.canRegenerate,
  fork: (_chat, msg) => !msg.isStreaming && !msg.isError,
  share: (_chat, msg) => msg.message.role === 'assistant' && !msg.isStreaming && !msg.isError,
  'retry-error': (_chat, msg) => msg.isError,
};

/**
 * Pure function: given chat context + message context, returns the set of allowed actions.
 */
export function resolveMessageActions(chat: ChatContext, msg: MessageContext): Set<MessageAction> {
  const privilegeKey = chat.privilege ?? 'none';
  const baseActions = BASE_PERMISSIONS[chat.mode][privilegeKey] ?? [];
  const allowed = new Set(baseActions);

  // Ownership gate: remove retry/edit for other user's messages in group contexts
  if (
    chat.isGroupChat &&
    msg.message.role === 'user' &&
    chat.currentUserId &&
    msg.message.senderId !== chat.currentUserId
  ) {
    allowed.delete('retry');
    allowed.delete('edit');
  }

  // Apply dynamic guards
  const result = new Set<MessageAction>();
  for (const action of allowed) {
    const guard = ACTION_GUARDS[action];
    if (!guard || guard(chat, msg)) {
      result.add(action);
    }
  }
  return result;
}

/**
 * Builds a ChatContext from the available props in the component tree.
 */
export function buildChatContext(options: {
  isAuthenticated: boolean;
  isLinkGuest: boolean;
  privilege: MemberPrivilege | undefined;
  currentUserId: string | undefined;
  isGroupChat: boolean;
}): ChatContext {
  if (!options.isAuthenticated && !options.isLinkGuest) {
    return { mode: 'trial', privilege: undefined, currentUserId: undefined, isGroupChat: false };
  }
  if (options.isLinkGuest) {
    return {
      mode: 'link-guest',
      privilege: options.privilege ?? 'read',
      currentUserId: options.currentUserId,
      isGroupChat: options.isGroupChat,
    };
  }
  if (options.isGroupChat) {
    return {
      mode: 'group',
      privilege: options.privilege,
      currentUserId: options.currentUserId,
      isGroupChat: true,
    };
  }
  return {
    mode: 'solo',
    privilege: 'owner',
    currentUserId: options.currentUserId,
    isGroupChat: false,
  };
}
