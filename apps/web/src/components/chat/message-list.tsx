import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { groupConsecutiveMessages, type MessageGroup } from '@/lib/chat-sender';
import { getMultiModelMessageIds, canRegenerateMessage } from '@/lib/chat-regeneration';
import {
  resolveMessageActions,
  buildChatContext,
  type MessageContext,
} from '@/lib/message-actions';
import { omitUndefined } from '@/lib/optional-props';
import { env } from '@/lib/env';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import type { LinkInfo } from '@/lib/chat-sender';
import type { MemberPrivilege } from '@hushbox/shared';

declare global {
  // Test-only escape hatch exposed by `MessageList` in dev/E2E builds. Calls
  // Virtuoso's native `scrollIntoView({ index, done })` and resolves when the
  // row is measured and rendered.
  var __virtuosoScrollToIndex: ((index: number) => Promise<void>) | undefined;
}

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

  // Playwright-only escape hatch. iPhone-15 viewport + tall media tiles cause
  // Virtuoso to virtualize away the target message-item before action helpers
  // can locate it. Exposing `scrollIntoView({ done })` lets tests deterministically
  // park a specific row in view and `await` its measurement.
  useEffect(() => {
    if (!env.isLocalDev && !env.isE2E) return;
    globalThis.__virtuosoScrollToIndex = (index: number): Promise<void> =>
      new Promise((resolve) => {
        const handle = virtuosoRef.current;
        if (!handle) {
          resolve();
          return;
        }
        handle.scrollIntoView({ index, align: 'center', behavior: 'auto', done: resolve });
      });
    return () => {
      globalThis.__virtuosoScrollToIndex = undefined;
    };
  }, []);

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

  // O(N) precompute so the render mapper does O(1) lookups per row instead of
  // calling isMultiModelResponse per message (each itself O(N) → O(N²) total).
  const multiModelIds = useMemo(() => getMultiModelMessageIds(messages), [messages]);

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
        data-message-count={0}
        data-decrypted-count={0}
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
      ...omitUndefined({
        currentUserId,
        members,
        links,
        modelName,
        onShare,
        onRegenerate,
        onEdit,
        onFork,
      }),
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
      isMultiModel: multiModelIds.has(message.id),
      canRegenerate: canRegenerateMessage(
        messages,
        message.id,
        chatContext.currentUserId ?? '',
        chatContext.isGroupChat
      ),
    };
    const allowedActions = resolveMessageActions(chatContext, msgContext);
    // retry-error outer RetryButton routes through the same handleRegenerate
    // as a per-tile click: resolveRegenerateTarget detects multi-model context
    // and sets replaceAssistantId so only this failed tile gets re-run.
    const onRetry =
      isError && onRegenerate
        ? (): void => {
            onRegenerate(message.id);
          }
        : undefined;
    return (
      <MessageItem
        key={group?.id ?? message.id}
        message={message}
        allowedActions={allowedActions}
        isStreaming={isStreaming}
        isError={isError}
        {...omitUndefined({ onRetry })}
        {...buildOptionalMessageProps(group)}
      />
    );
  }

  const assistantCount = messages.filter((m) => m.role === 'assistant').length;
  const costCount = messages.filter((m) => m.cost != null).length;
  // `useDecryptedMessages` writes a sentinel content prefix when the wrap-
  // once envelope can't be opened; exclude those so the count reflects
  // text-ready messages.
  const decryptedCount = messages.filter((m) => !m.content.startsWith('[decryption failed')).length;

  return (
    <div
      role="log"
      aria-label="Chat messages"
      data-testid="message-list"
      data-assistant-count={assistantCount}
      data-cost-count={costCount}
      data-message-count={messages.length}
      data-decrypted-count={decryptedCount}
      data-rows-count={rows.length}
      data-virtuoso-scrolling={String(isVirtuosoScrolling)}
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso<MessageRow>
        ref={virtuosoRef}
        data={rows}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
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
