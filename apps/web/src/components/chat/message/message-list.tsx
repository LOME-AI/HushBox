import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { TEST_IDS } from '@hushbox/shared';
import { groupConsecutiveMessages, type MessageGroup } from '@/lib/chat-sender';
import { getMultiModelMessageIds, canRegenerateMessage } from '@/lib/chat-regeneration';
import {
  resolveMessageActions,
  buildChatContext,
  type MessageContext,
} from '@/lib/message-actions';
import { omitUndefined } from '@/lib/optional-props';
import { env } from '@/lib/env';
import { MessageItem } from '@/components/chat/message/message-item';
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
  /**
   * Server-side persistence-tracking set. Cleared on the SSE `done` event
   * (post-saveChatTurn commit), distinct from {@link streamingMessageIds}
   * which clears on the earlier `model:done` flip (pre-persistence).
   * Drives `data-streaming-count` and `data-streams-completed` — the DOM
   * attributes used by E2E tests to know when the server has actually
   * committed a turn. Per-row `isStreaming` keeps reading
   * `streamingMessageIds` so the toolbar / input UX stays fast.
   */
  persistingMessageIds?: Set<string> | undefined;
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
  /**
   * Parent-derived signal that the message list reflects the final data for
   * the current conversation/fork — conversation query loaded, fork resolved,
   * decryption pass complete. Tests wait on this attribute before reading
   * `data-message-count` to avoid the "stable at 0 mid-decryption" race that
   * the legacy polling helper had. Defaults to `false` so a missing prop
   * never lets a test trust an in-flight render.
   */
  messagesReady?: boolean | undefined;
  /**
   * Stable identifier for the current conversation/fork pair. When it changes,
   * the component resets the user-scrolled-away flag and snaps Virtuoso back
   * to the latest message — without unmounting. The previous implementation
   * achieved this reset via `key=` on the parent, which forced a full remount
   * during the welcome → first-real-id transition and produced a visible
   * blank-frame flash.
   */
  conversationKey?: string | undefined;
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

const MessageListInner = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    streamingMessageIds,
    persistingMessageIds,
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
    messagesReady = false,
    conversationKey,
  },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const userScrolledAwayRef = useRef(false);
  const [isVirtuosoScrolling, setIsVirtuosoScrolling] = useState(false);
  // Whether the list is pinned within Virtuoso's `atBottomThreshold` of the
  // bottom. Exposed as `data-at-bottom` so E2E auto-scroll assertions gate on
  // the app's own settled-at-bottom state instead of reading raw scroll pixels
  // at an instant the post-stream layout (e.g. code-block highlight) is still
  // growing. Starts true: the list mounts pinned at LAST.
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Sticky-with-decay flag set by wheel/touchmove/keydown listeners attached
  // to the Virtuoso scroller. True while the user is actively scrolling or
  // within `USER_SCROLL_DECAY_MS` of a user-input event. Programmatic
  // scrolls (`followOutput`, `scrollToIndex`, the Playwright
  // `__virtuosoScrollToIndex` backdoor) do not fire these events, so they
  // leave the flag false.
  //
  // The `isScrolling` callback Virtuoso surfaces can't be used as a "user
  // is scrolling" signal because it fires on any `scrollTop` change,
  // including programmatic scrolls — see the operator chain at
  // node_modules/.../react-virtuoso/dist/index.mjs (the `p` stream is a
  // debounced derivative of `scrollTop` changes, regardless of source).
  //
  // Known gap: native desktop scrollbar drag fires neither wheel nor
  // touchmove. In practice a drag back to bottom re-engages via the
  // `atBottom` branch; a drag-up-and-stop is the only case followOutput
  // will keep pinning — rare on a chat list.
  const userScrolledRef = useRef(false);
  const userScrollDecayTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollerElRef = useRef<HTMLElement | null>(null);

  // Monotonic counter of completed stream cycles. Increments whenever
  // `persistingMessageIds` transitions from non-empty to empty — i.e. every
  // time a streaming turn finishes AND the server has committed the
  // resulting messages. Exposed as `data-streams-completed` so E2E tests
  // can capture a baseline before triggering an action and wait for it to
  // advance, avoiding races where the stream finishes faster than a
  // polling assertion can observe `data-streaming-count > 0`. Gating on
  // persistingMessageIds (not streamingMessageIds) is what makes the
  // "wait" actually mean "server committed" — see use-chat-page.ts for
  // why the two sets exist.
  const currentStreamingCount = persistingMessageIds?.size ?? 0;
  const [streamsCompleted, setStreamsCompleted] = useState(0);
  const [previousStreamingCount, setPreviousStreamingCount] = useState(currentStreamingCount);
  if (previousStreamingCount !== currentStreamingCount) {
    setPreviousStreamingCount(currentStreamingCount);
    if (previousStreamingCount > 0 && currentStreamingCount === 0) {
      setStreamsCompleted((n) => n + 1);
    }
  }

  // Reset scroll state when the conversation/fork pair changes. Replaces the
  // parent's `key=` remount, which previously unmounted Virtuoso (and the
  // surrounding chat layout) during the /chat → /chat/{realId} transition,
  // producing a visible blank-frame flash. The initial mount sets the ref
  // here too; the first render still runs `initialTopMostItemIndex='LAST'`.
  const previousConversationKeyRef = useRef<string | undefined>(conversationKey);
  useEffect(() => {
    if (previousConversationKeyRef.current === conversationKey) return;
    previousConversationKeyRef.current = conversationKey;
    userScrolledAwayRef.current = false;
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
  }, [conversationKey]);

  // Must exceed Footer height (10dvh) so scrollToIndex({ index: 'LAST' })
  // lands within the threshold and atBottomStateChange reports true.
  const [atBottomThreshold] = useState((): number => Math.ceil(window.innerHeight * 0.1) + 20);

  const handleIsScrolling = useCallback((scrolling: boolean): void => {
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

  // Playwright-only escape hatch for parking a virtualized row in view.
  // `align: 'start'` (not 'center') because center-alignment for rows
  // taller than half the viewport clamps to the scroll edge and Virtuoso
  // can treat that as a no-op. `userScrolledAwayRef = true` before the
  // scroll so a follow-up refetch's `followOutput()` doesn't re-pin to
  // the bottom and unmount the just-scrolled-to row.
  useEffect(() => {
    if (!env.isLocalDev && !env.isE2E) return;
    globalThis.__virtuosoScrollToIndex = (index: number): Promise<void> =>
      new Promise((resolve) => {
        const handle = virtuosoRef.current;
        if (!handle) {
          resolve();
          return;
        }
        userScrolledAwayRef.current = true;
        handle.scrollIntoView({ index, align: 'start', behavior: 'auto', done: resolve });
      });
    return () => {
      globalThis.__virtuosoScrollToIndex = undefined;
    };
  }, []);

  // Time after the last user-input event during which a subsequent
  // `atBottomStateChange(false)` is still attributed to the user. Long enough
  // to span an inertia-scroll fling on touch devices; short enough that a
  // stream chunk arriving more than ~250ms after the last user input is
  // correctly treated as content growth, not user action.
  const USER_SCROLL_DECAY_MS = 250;

  const markUserScroll = useCallback((): void => {
    userScrolledRef.current = true;
    if (userScrollDecayTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(userScrollDecayTimeoutRef.current);
    }
    userScrollDecayTimeoutRef.current = globalThis.setTimeout(() => {
      userScrolledRef.current = false;
      userScrollDecayTimeoutRef.current = undefined;
    }, USER_SCROLL_DECAY_MS);
  }, []);

  const handleUserScrollKey = useCallback(
    (event: KeyboardEvent): void => {
      // Keys that move the scroll position when the scroller has focus.
      // Space scrolls down a viewport; Shift+Space scrolls up.
      if (
        event.key === 'PageDown' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === ' '
      ) {
        markUserScroll();
      }
    },
    [markUserScroll]
  );

  // Attach/detach listeners as Virtuoso provides/replaces the scroller DOM
  // element. Doing this inside the ref callback (not a useEffect) handles
  // remounts cleanly: Virtuoso invokes the callback with `null` on unmount
  // and with the new element on remount.
  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null): void => {
      const previous = scrollerElRef.current;
      if (previous) {
        previous.removeEventListener('wheel', markUserScroll);
        previous.removeEventListener('touchmove', markUserScroll);
        previous.removeEventListener('keydown', handleUserScrollKey);
      }
      scrollerElRef.current = el instanceof HTMLElement ? el : null;
      const next = scrollerElRef.current;
      if (next) {
        next.addEventListener('wheel', markUserScroll, { passive: true });
        next.addEventListener('touchmove', markUserScroll, { passive: true });
        next.addEventListener('keydown', handleUserScrollKey);
      }
    },
    [markUserScroll, handleUserScrollKey]
  );

  // Clear any pending decay timeout when the component unmounts. The
  // listeners themselves are released through `handleScrollerRef(null)`.
  useEffect(() => {
    return () => {
      if (userScrollDecayTimeoutRef.current !== undefined) {
        globalThis.clearTimeout(userScrollDecayTimeoutRef.current);
        userScrollDecayTimeoutRef.current = undefined;
      }
    };
  }, []);

  const handleAtBottomStateChange = useCallback((atBottom: boolean): void => {
    setIsAtBottom(atBottom);
    if (!atBottom && userScrolledRef.current) {
      // Only flag scrolled-away when the user is actively scrolling. A
      // bare `!atBottom` would also fire during streaming when content
      // grows faster than the auto-scroll catches up — a webkit-prone race
      // that previously disengaged followOutput mid-stream.
      userScrolledAwayRef.current = true;
    } else if (atBottom) {
      // Always re-engage when we land back at the bottom — whether the user
      // scrolled there or followOutput caught up.
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
  //
  // The DOM-attribute counts are derived here in one pass over `messages` so
  // they don't re-filter the list three times on every streaming token.
  // `decryptedCount` excludes the sentinel content prefix `useDecryptedMessages`
  // writes when the wrap-once envelope can't be opened, so it reflects
  // text-ready messages.
  const { rows, assistantCount, costCount, decryptedCount } = useMemo<{
    rows: MessageRow[];
    assistantCount: number;
    costCount: number;
    decryptedCount: number;
  }>(() => {
    let assistant = 0;
    let cost = 0;
    let decrypted = 0;
    for (const message of messages) {
      if (message.role === 'assistant') assistant += 1;
      if (message.cost != null) cost += 1;
      if (!message.content.startsWith('[decryption failed')) decrypted += 1;
    }
    const built: MessageRow[] = groups
      ? groups.map((group) => {
          const first = group.messages[0];
          return {
            key: group.id,
            group,
            ...(first !== undefined && { message: first }),
            isStreaming: group.messages.some((m) => streamingMessageIds?.has(m.id) ?? false),
            isError: group.messages.some(
              (m) => m.id === errorMessageId || m.errorCode !== undefined
            ),
          };
        })
      : messages.map((message) => ({
          key: message.id,
          message,
          isStreaming: streamingMessageIds?.has(message.id) ?? false,
          isError: message.id === errorMessageId || message.errorCode !== undefined,
        }));
    return { rows: built, assistantCount: assistant, costCount: cost, decryptedCount: decrypted };
  }, [groups, messages, streamingMessageIds, errorMessageId]);

  const computeItemKey = useCallback((_index: number, row: MessageRow): string => row.key, []);

  if (messages.length === 0) {
    return (
      <div
        role="log"
        aria-label="Chat messages"
        data-testid={TEST_IDS.messageListEmpty}
        data-message-count={0}
        data-decrypted-count={0}
        data-streaming-count={0}
        data-messages-ready={String(messagesReady)}
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

  return (
    <div
      role="log"
      aria-label="Chat messages"
      data-testid={TEST_IDS.messageList}
      data-assistant-count={assistantCount}
      data-cost-count={costCount}
      data-streaming-count={persistingMessageIds?.size ?? 0}
      data-streams-completed={streamsCompleted}
      data-message-count={messages.length}
      data-decrypted-count={decryptedCount}
      data-rows-count={rows.length}
      data-virtuoso-scrolling={String(isVirtuosoScrolling)}
      data-at-bottom={String(isAtBottom)}
      data-messages-ready={String(messagesReady)}
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso<MessageRow>
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        data={rows}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        computeItemKey={computeItemKey}
        isScrolling={handleIsScrolling}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={atBottomThreshold}
        // Keep rows mounted ~one viewport above and below the visible area.
        // Accessibility: screen readers + browser find-in-page need
        // off-screen content in the DOM. Also closes a race where a tile's
        // post-stream size grows (e.g. media bytes arriving) pushes the
        // previous-bottom row outside the visible area; without overscan
        // Virtuoso unmounts it before the user (or an E2E assertion) can
        // see it.
        increaseViewportBy={{ top: 800, bottom: 800 }}
        itemContent={(_index, row) => {
          if (row.message === undefined) return null;
          return renderMessageItem(row.message, row.isStreaming, row.isError, row.group);
        }}
        components={components}
      />
    </div>
  );
});

// Memoized so a parent re-render that leaves these props referentially stable
// (e.g. a prompt-input keystroke updating sibling state) skips the virtualized
// list entirely. The parent (ChatMainContent) is responsible for keeping the
// callback / array props stable; see chat-main-content.tsx.
export const MessageList = memo(MessageListInner);
