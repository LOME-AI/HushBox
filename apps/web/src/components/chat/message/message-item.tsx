import * as React from 'react';
import { assistantAnswerText, TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { MessageBody } from '@/components/chat/message/message-body';
import { useWrittenUnderInvalidKeys } from '@/components/chat/message/bad-epochs-context';
import { InvalidKeysNotice } from '@/components/chat/message/invalid-keys-notice';
import { AIMessageBlock } from '@/components/chat/message/ai-message-block';
import { MessageControls } from '@/components/chat/message/message-controls';
import { MessageCost } from '@/components/chat/message/message-cost';
import {
  computeBubbleVariant,
  computeContainerClasses,
  computeMessageDisplayState,
  type MemberInfo,
} from '@/components/chat/message/message-display-state';
import {
  buildMessageEnvelopeContext,
  messageMediaToRenderable,
  type MessageEnvelopeContext,
  type RenderableMedia,
} from '@/components/chat/media/media-content-item';
import type { ModelsData } from '@/hooks/models/models';
import type { ContentKey, WrappedSecret } from '@hushbox/crypto';
import type { MessageGroup, LinkInfo } from '@/lib/chat/sender';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';
import type { NoticeReason } from '@hushbox/shared';

interface MessageItemProps {
  message: Message;
  /** Set of actions allowed for this message, determined by resolveMessageActions */
  allowedActions: Set<MessageAction>;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Display name of the selected model, shown in thinking indicator */
  modelName?: string;
  isError?: boolean;
  onShare?: (messageId: string) => void;
  /** Called when user clicks regenerate (AI) or retry (user) */
  onRegenerate?: (messageId: string) => void;
  /**
   * The send gate's refusal as it applies to re-running a turn, or `undefined`
   * when it may run. Both affordances that re-run a turn read it: Regenerate on
   * an assistant message and Retry on a user message are one paid action behind
   * one handler, so gating only one would leave the other spending unchecked.
   */
  regenerateRefusal?: NoticeReason;
  /** Called when user clicks edit on a user message */
  onEdit?: (messageId: string, content: string) => void;
  /** Called when the user forks at a reply */
  onFork?: (messageId: string) => void;
  /** Group of consecutive messages (group chat mode) */
  group?: MessageGroup;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for determining alignment and labels */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
  /** Shared links for resolving link guest sender names */
  links?: LinkInfo[];
  /**
   * The model catalog, read once for the whole list. A row never subscribes to
   * the query itself: a subscription per row puts a query stack inside a
   * virtualised item that re-renders on every streaming token.
   */
  models?: ModelsData | undefined;
}

/**
 * Map a message's persisted media items onto the shared `RenderableMedia`
 * shape, position-sorted. Returns [] when the message carries no media, was
 * written under invalid keys, or is missing the wrap-once envelope fields
 * needed to decrypt them, so such a message renders no media container. When `envelope` is set (the epoch key
 * has resolved) each item is stamped with the location-bound decryptor; while
 * it is undefined the items render as loading until the key lands.
 */
/**
 * Assemble the message-level envelope context for a message's media. `senderId`
 * substitutes '' for a null/scrubbed sender; a write always binds a real sender
 * (a user id or the assistant constant), so that stand-in deliberately matches
 * nothing (mirrors the text path's reconstruction).
 */
function mediaEnvelopeContextFor(
  message: Message,
  contentKey: ContentKey | null,
  wrappedContentKey: WrappedSecret | null
): MessageEnvelopeContext | undefined {
  return buildMessageEnvelopeContext({
    contentKey,
    wrappedContentKey,
    conversationId: message.conversationId,
    messageId: message.id,
    epochNumber: message.epochNumber,
    senderId: message.senderId ?? '',
  });
}

function buildRenderableMedia(
  message: Message,
  envelope: MessageEnvelopeContext | undefined,
  invalidKeys: boolean
): RenderableMedia[] {
  const { mediaItems, wrappedContentKey, epochNumber } = message;
  if (invalidKeys) return [];
  if (!mediaItems || mediaItems.length === 0) return [];
  if (!wrappedContentKey || epochNumber === undefined) return [];
  return mediaItems
    .toSorted((a, b) => a.position - b.position)
    .map((item) => messageMediaToRenderable(item, envelope));
}

/** A message whose content is gone or unreadable has nothing to copy, re-run or fork. */
function offersMessageActions(deleted: boolean, invalidKeys: boolean): boolean {
  return !deleted && !invalidKeys;
}

function UserMessageContent({
  messagesToRender,
  isGroupedUser,
  message,
  writtenUnderInvalidKeys,
}: Readonly<{
  messagesToRender: Message[];
  isGroupedUser: boolean;
  message: Message;
  writtenUnderInvalidKeys: (epochNumber: number | undefined) => boolean;
}>): React.JSX.Element {
  if (isGroupedUser) {
    return (
      <>
        {messagesToRender.map((msg, index) =>
          writtenUnderInvalidKeys(msg.epochNumber) ? (
            <InvalidKeysNotice key={msg.id} className={cn(index > 0 && 'mt-3')} />
          ) : (
            <p
              key={msg.id}
              className={cn(
                'text-base leading-relaxed break-words whitespace-pre-wrap',
                index > 0 && 'mt-3'
              )}
            >
              {msg.content}
            </p>
          )
        )}
      </>
    );
  }
  return (
    <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
  );
}

/** A user message's bubble and controls hug its edge; a reply's body and footer span the column. */
function stackClasses(isUser: boolean, ownMessage: boolean): string {
  if (!isUser) return 'flex flex-col gap-2.5';
  return cn('flex flex-col gap-1.5', ownMessage && 'items-end');
}

/**
 * A user bubble shrink-wraps inside its stack; capping it at the stack's width is what
 * lets an unbroken run (a URL, a hash) wrap instead of spilling out of the column.
 */
function bubbleWidth(isUser: boolean): { className?: string } {
  return isUser ? { className: 'min-w-0 max-w-full' } : {};
}

/**
 * Where a message's controls sit: under a user message's bubble, or in a reply's
 * footer row after its cost. The row keeps its height while the reply streams, so
 * the controls arrive without moving the thread.
 */
function ControlsPlacement({
  isUser,
  cost,
  children,
}: Readonly<{
  isUser: boolean;
  cost: Message['cost'];
  children: React.ReactNode;
}>): React.JSX.Element {
  if (isUser) return <>{children}</>;
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 pointer-coarse:min-h-11">
      {cost && <MessageCost cost={cost} />}
      {children}
    </div>
  );
}

function MessageItemInner({
  message,
  allowedActions,
  isStreaming,
  modelName,
  isError,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  group,
  isGroupChat,
  currentUserId,
  members,
  links,
  regenerateRefusal,
  models,
}: Readonly<MessageItemProps>): React.JSX.Element {
  const {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  } = computeMessageDisplayState({ message, group, isGroupChat, currentUserId, members, links });

  // Media lives on the individual `message` for user bubbles and on the
  // representative `primaryMessage` for assistant bubbles (group chat collapses
  // consecutive user messages, never assistant ones). Resolve the content key
  // ONCE here and hand it to the shared media list.
  const mediaSourceMessage = isUser ? message : primaryMessage;
  // A deleted message never groups (it has no sender), so its own flag decides
  // the whole bubble. Its erased content leaves nothing to unwrap a key for.
  const deleted = mediaSourceMessage.deleted === true;
  // Judged per message: a grouped bubble can hold readable messages beside
  // unreadable ones. The whole bubble is replaced only when none is readable,
  // and nothing in it is copied, re-run or forked while any one is unreadable.
  const writtenUnderInvalidKeys = useWrittenUnderInvalidKeys();
  const invalidKeys = messagesToRender.every((m) => writtenUnderInvalidKeys(m.epochNumber));
  const anyInvalidKeys = messagesToRender.some((m) => writtenUnderInvalidKeys(m.epochNumber));
  const {
    contentKey,
    wrappedContentKey: contentKeyWrap,
    error: contentKeyError,
  } = useMessageContentKey(
    mediaSourceMessage.conversationId,
    mediaSourceMessage.epochNumber ?? 0,
    deleted ? '' : (mediaSourceMessage.wrappedContentKey ?? '')
  );
  // Complete once the epoch key resolves; until then media items render as
  // loading.
  const envelopeContext = mediaEnvelopeContextFor(mediaSourceMessage, contentKey, contentKeyWrap);
  const media = buildRenderableMedia(
    mediaSourceMessage,
    envelopeContext,
    writtenUnderInvalidKeys(mediaSourceMessage.epochNumber)
  );

  // Clipboard is a user-facing surface: assistant text carries reasoning and
  // search rows in the same field (store raw, parse on demand), so copy emits
  // the answer projection. User content copies verbatim, matching display.
  const copyText = (): string =>
    messagesToRender
      .map((m) => (m.role === 'assistant' ? assistantAnswerText(m.content) : m.content))
      .join('\n\n');

  const containerClasses = computeContainerClasses(isUser, isGroupedUser, ownMessage);
  const bubbleVariant = computeBubbleVariant(isUser, isGroupedUser, ownMessage);

  return (
    <ChatColumn>
      {senderLabel && (
        <p
          data-testid={TEST_IDS.senderLabel}
          className={cn('text-foreground mt-1 px-1 text-xs', ownMessage && 'text-right')}
        >
          {senderLabel}
        </p>
      )}
      <div
        data-testid={TEST_IDS.messageItem}
        data-role={effectiveRole}
        data-message-id={primaryMessage.id}
        {...(isError ? { 'data-error': 'true' } : {})}
        className={containerClasses}
      >
        <div className={stackClasses(isUser, ownMessage)}>
          <MessageBody
            variant={bubbleVariant}
            media={media}
            contentKeyError={contentKeyError}
            ariaPrefix="Generated"
            deleted={deleted}
            invalidKeys={invalidKeys}
            {...bubbleWidth(isUser)}
          >
            {isUser ? (
              <UserMessageContent
                messagesToRender={messagesToRender}
                isGroupedUser={isGroupedUser}
                message={message}
                writtenUnderInvalidKeys={writtenUnderInvalidKeys}
              />
            ) : (
              <AIMessageBlock
                primaryMessage={primaryMessage}
                isStreaming={isStreaming}
                modelName={modelName}
                models={models}
              />
            )}
          </MessageBody>

          {offersMessageActions(deleted, anyInvalidKeys) && (
            <ControlsPlacement isUser={isUser} cost={primaryMessage.cost}>
              <MessageControls
                message={primaryMessage}
                allowed={allowedActions}
                handlers={{ onShare, onRegenerate, onEdit, onFork, copyText }}
                regenerateRefusal={regenerateRefusal}
              />
            </ControlsPlacement>
          )}
        </div>
      </div>
    </ChatColumn>
  );
}

/**
 * Two props are rebuilt on every list render and would defeat the memo on
 * identity alone, so both are compared by content: `allowedActions` is a fresh
 * `Set` out of `resolveMessageActions`, and `group` is rebuilt whenever the
 * `messages` array identity moves. Every other prop — including one added
 * later — falls through to identity, which is what keeps the row honest: the
 * streaming pipeline rebuilds only the message a token landed on and leaves
 * every other message object intact.
 */
function sameActions(
  previous: ReadonlySet<MessageAction>,
  next: ReadonlySet<MessageAction>
): boolean {
  if (previous.size !== next.size) return false;
  for (const action of previous) {
    if (!next.has(action)) return false;
  }
  return true;
}

function sameGroup(previous: MessageGroup | undefined, next: MessageGroup | undefined): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  if (previous.id !== next.id) return false;
  if (previous.role !== next.role) return false;
  if (previous.senderId !== next.senderId) return false;
  if (previous.messages.length !== next.messages.length) return false;
  return previous.messages.every((message, index) => message === next.messages[index]);
}

function arePropsEqual(
  previous: Readonly<MessageItemProps>,
  next: Readonly<MessageItemProps>
): boolean {
  const keys = Object.keys(next) as (keyof MessageItemProps)[];
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every((key) => {
    if (key === 'allowedActions') return sameActions(previous.allowedActions, next.allowedActions);
    if (key === 'group') return sameGroup(previous.group, next.group);
    return (previous[key] as unknown) === (next[key] as unknown);
  });
}

/**
 * Memoised because the list re-renders on every streamed token: without this
 * boundary every mounted row re-runs its whole subtree — the markdown stack,
 * the media envelope, the segment parse, for a message that did not move.
 * The permanent cost is that every prop feeding a row must be stable or
 * content-compared; see {@link arePropsEqual}.
 */
export const MessageItem = React.memo(MessageItemInner, arePropsEqual);
