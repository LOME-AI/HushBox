import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import { groupConsecutiveMessages, type MessageGroup } from '@/lib/chat-sender';
import type { LinkInfo } from '@/lib/chat-sender';
import { isMultiModelResponse, canRegenerateMessage } from '@/lib/chat-regeneration';
import {
  resolveMessageActions,
  buildChatContext,
  type MessageContext,
} from '@/lib/message-actions';
import type { MemberPrivilege } from '@hushbox/shared';

/**
 * Data row for a single Virtuoso item. Wraps the message (or group) together
 * with the per-row render state (`isStreaming`, `isError`). These flags are
 * baked into the data so that any change to streaming / error state produces
 * a new `data` array reference — which is how React Virtuoso decides whether
 * to re-render items. Passing this state via closure or via the `context`
 * prop is unreliable on WebKit: the virtualized ItemComponent stays memoised
 * on the same item reference and misses closure changes, leaving the UI with
 * a stale `isStreaming=true` after the stream completes (action buttons go
 * missing even though the cost badge is rendered). Baking state into the
 * item avoids the problem entirely.
 */
interface MessageRow {
  /** Stable React key — the message or group id. */
  key: string;
  /** For flat-list mode: the message being rendered. */
  message?: Message;
  /** For group-chat mode: the group being rendered. */
  group?: MessageGroup;
  isStreaming: boolean;
  isError: boolean;
}

interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface MessageListProps {
  messages: Message[];
  streamingMessageIds?: Set<string> | undefined;
  errorMessageId?: string | undefined;
  modelName?: string | undefined;
  onShare?: ((messageId: string) => void) | undefined;
  /** Called when user clicks regenerate (AI) or retry (user) */
  onRegenerate?: ((messageId: string) => void) | undefined;
  /** Called when user clicks edit on a user message */
  onEdit?: ((messageId: string, content: string) => void) | undefined;
  /** Called when user clicks fork on any message */
  onFork?: ((messageId: string) => void) | undefined;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for sender labels and alignment */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
  /** Shared links for resolving link guest sender names */
  links?: LinkInfo[];
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  /** Whether the user is a link guest */
  isLinkGuest?: boolean;
  /** The caller's privilege level */
  callerPrivilege?: MemberPrivilege | undefined;
}

export interface MessageListHandle extends VirtuosoHandle {
  resetScrollBreakaway: () => void;
}

const FOOTER_HEIGHT = '10dvh';

const Footer = (): React.JSX.Element => (
  <div style={{ height: FOOTER_HEIGHT }} aria-hidden="true" />
);

const Scroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Scroller(props, ref) {
    return <div {...props} ref={ref} data-slot="scroll-area-viewport" />;
  }
);

const Header = (): React.JSX.Element => <div className="h-4" aria-hidden="true" />;

const components = { Header, Footer, Scroller };

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    streamingMessageIds,
    errorMessageId,
    modelName,
    onShare,
    onRegenerate,
    onEdit,
    onFork,
    isGroupChat,
    currentUserId,
    members,
    links,
    isAuthenticated,
    isLinkGuest,
    callerPrivilege,
  },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const userScrolledAwayRef = useRef(false);
  const isScrollingRef = useRef(false);
  const [isVirtuosoScrolling, setIsVirtuosoScrolling] = useState(false);

  // Must exceed Footer height (10dvh) so scrollToIndex({ index: 'LAST' })
  // lands within the threshold and atBottomStateChange reports true.
  const [atBottomThreshold] = useState((): number => Math.ceil(window.innerHeight * 0.1) + 20);

  const handleIsScrolling = useCallback((scrolling: boolean): void => {
    isScrollingRef.current = scrolling;
    setIsVirtuosoScrolling(scrolling);
  }, []);

  useImperativeHandle(ref, () => {
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) {
      return { resetScrollBreakaway: (): void => undefined } as MessageListHandle;
    }
    return {
      ...virtuoso,
      resetScrollBreakaway: (): void => {
        userScrolledAwayRef.current = false;
      },
    };
  });

  const handleAtBottomStateChange = useCallback((atBottom: boolean): void => {
    if (!atBottom) {
      userScrolledAwayRef.current = true;
    } else if (isScrollingRef.current) {
      // Only re-engage when the user is actively scrolling to bottom,
      // not when content growth passively moves them within threshold.
      userScrolledAwayRef.current = false;
    }
  }, []);

  const followOutput = useCallback((): boolean => {
    return !userScrolledAwayRef.current;
  }, []);

  const chatContext = useMemo(
    () =>
      buildChatContext({
        isAuthenticated: isAuthenticated ?? true,
        isLinkGuest: isLinkGuest ?? false,
        privilege: callerPrivilege,
        currentUserId,
        isGroupChat: isGroupChat ?? false,
      }),
    [isAuthenticated, isLinkGuest, callerPrivilege, currentUserId, isGroupChat]
  );

  const groups = useMemo(
    () => (isGroupChat ? groupConsecutiveMessages(messages) : null),
    [isGroupChat, messages]
  );

  // Bake per-row render state into the data array. When streamingMessageIds
  // or errorMessageId changes, this produces a fresh array with fresh row
  // objects — guaranteeing Virtuoso sees a data-identity change and
  // re-renders items. See MessageRow docstring for the WebKit rationale.
  const rows = useMemo<MessageRow[]>(() => {
    if (groups) {
      return groups.map((group) => {
        const first = group.messages[0];
        return {
          key: group.id,
          group,
          ...(first !== undefined && { message: first }),
          isStreaming: group.messages.some((m) => streamingMessageIds?.has(m.id) ?? false),
          isError: group.messages.some((m) => m.id === errorMessageId || m.errorCode !== undefined),
        };
      });
    }
    return messages.map((message) => ({
      key: message.id,
      message,
      isStreaming: streamingMessageIds?.has(message.id) ?? false,
      isError: message.id === errorMessageId || message.errorCode !== undefined,
    }));
  }, [groups, messages, streamingMessageIds, errorMessageId]);

  const computeItemKey = useCallback((_index: number, row: MessageRow): string => row.key, []);

  if (messages.length === 0) {
    return (
      <div
        role="log"
        aria-label="Chat messages"
        data-testid="message-list-empty"
        className="flex flex-1 items-center justify-center"
      >
        <p className="text-muted-foreground">No messages yet</p>
      </div>
    );
  }

  function buildOptionalMessageProps(
    group: MessageGroup | undefined
  ): Partial<React.ComponentProps<typeof MessageItem>> {
    return {
      ...(group !== undefined && { group, isGroupChat: true as const }),
      ...(currentUserId !== undefined && { currentUserId }),
      ...(members !== undefined && { members }),
      ...(links !== undefined && { links }),
      ...(modelName !== undefined && { modelName }),
      ...(onShare !== undefined && { onShare }),
      ...(onRegenerate !== undefined && { onRegenerate }),
      ...(onEdit !== undefined && { onEdit }),
      ...(onFork !== undefined && { onFork }),
    };
  }

  function renderMessageItem(
    message: Message,
    isStreaming: boolean,
    isError: boolean,
    group?: MessageGroup
  ): React.JSX.Element | null {
    const msgContext: MessageContext = {
      message,
      isStreaming,
      isError,
      isMultiModel: isMultiModelResponse(messages, message.id),
      canRegenerate: canRegenerateMessage(
        messages,
        message.id,
        chatContext.currentUserId ?? '',
        chatContext.isGroupChat
      ),
    };
    const allowedActions = resolveMessageActions(chatContext, msgContext);
    return (
      <MessageItem
        key={group?.id ?? message.id}
        message={message}
        allowedActions={allowedActions}
        isStreaming={isStreaming}
        isError={isError}
        {...buildOptionalMessageProps(group)}
      />
    );
  }

  const assistantCount = messages.filter((m) => m.role === 'assistant').length;
  const costCount = messages.filter((m) => m.cost != null).length;

  return (
    <div
      role="log"
      aria-label="Chat messages"
      data-testid="message-list"
      data-assistant-count={assistantCount}
      data-cost-count={costCount}
      data-message-count={messages.length}
      data-virtuoso-scrolling={String(isVirtuosoScrolling)}
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso<MessageRow>
        ref={virtuosoRef}
        data={rows}
        computeItemKey={computeItemKey}
        isScrolling={handleIsScrolling}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={atBottomThreshold}
        itemContent={(_index, row) => {
          if (row.message === undefined) return null;
          return renderMessageItem(row.message, row.isStreaming, row.isError, row.group);
        }}
        components={components}
      />
    </div>
  );
});
