import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { canSendMessages, TEST_IDS } from '@hushbox/shared';
import { useAnimationFrame } from '@hushbox/ui';
import {
  groupSenderRuns,
  groupSiblingReplies,
  type SiblingReplies,
} from '@/lib/chat/sibling-replies';
import { getMultiModelMessageIds, canRegenerateMessage } from '@/lib/chat/regeneration';
import {
  resolveMessageActions,
  buildChatContext,
  rerunGateScope,
  type MessageContext,
} from '@/lib/chat/message-actions';
import { omitUndefined } from '@/lib/utils/optional-props';
import { env } from '@/lib/platform/env';
import { isDecryptionFailure } from '@/hooks/crypto/use-decrypted-messages';
import { useModels } from '@/hooks/models/models';
import { usePreInferenceActivityStore } from '@/stores/activity/pre-inference';
import { useStreamCycleActivityStore } from '@/stores/activity/stream-cycle';
import { MessageItem } from '@/components/chat/message/message-item';
import { RegenerateGate } from '@/components/chat/message/regenerate-gate';
import { components, type ListContext } from '@/components/chat/message/message-list-slots';
import { waitForThreadFonts, type ThreadFontWait } from '@/components/chat/message/thread-fonts';
import { CompareGroup } from '@/components/chat/message/compare-group';
import {
  countStillFrame,
  noticeViewLocation,
  rowIndexHolding,
  STILLNESS_UNCOUNTED,
  unseenNotices,
} from '@/components/chat/message/notice-in-view';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { ForkMark } from '@/components/chat/layout/fork-mark';
import { computeContainerClasses } from '@/components/chat/message/message-display-state';
import { TurnNoticeView } from '@/components/chat/notice/turn-notice-view';
import { useMarkdownRendererReady } from '@/components/chat/segments/segment-renderers';
import type { ComparePresentation } from '@/components/chat/message/ai-message-block';
import type { Message } from '@/lib/api/api';
import type { LinkInfo, MessageGroup } from '@/lib/chat/sender';
import type { MemberPrivilege, Model, NoticeReason } from '@hushbox/shared';
import type { BranchSummary } from '@/lib/chat/branch-summary';
import type { TurnNotice } from '@/lib/chat/turn-notice';

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
  /** For a compare turn: each reply with its own render state, in the turn's order. */
  replies?: readonly ReplyCell[];
  isStreaming: boolean;
  isError: boolean;
  /** How many other branches part after this row, when the current branch parts there. */
  forkMore?: number;
}

/** One reply of a compare turn, with the render state baked in for the reason above. */
interface ReplyCell {
  message: Message;
  isStreaming: boolean;
  isError: boolean;
}

/**
 * Each fork point the current branch parts at, by the id of the message the branches share
 * last, mapped to how many other branches part there.
 */
function forkMarkCounts(
  branches: readonly BranchSummary[] | undefined,
  currentForkId: string | null | undefined
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  if (branches === undefined || currentForkId == null) return counts;
  const forksAtPoint = new Map<string, Set<string>>();
  for (const { forkId, forkPointId } of branches) {
    if (forkPointId === null) continue;
    const forks = forksAtPoint.get(forkPointId) ?? new Set<string>();
    forks.add(forkId);
    forksAtPoint.set(forkPointId, forks);
  }
  for (const [pointId, forks] of forksAtPoint) {
    if (forks.has(currentForkId) && forks.size > 1) counts.set(pointId, forks.size - 1);
  }
  return counts;
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
  /** Whether the thread is one message shared by link, whose reader may only copy it. */
  isMessageLink?: boolean | undefined;
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
  /** Every branch at every fork point; the fork marks are drawn from these. */
  branches?: readonly BranchSummary[] | undefined;
  /** The branch shown, whose fork points are marked. */
  activeForkId?: string | null | undefined;
  /** Opens the branch switcher from a fork mark. */
  onOpenBranches?: (() => void) | undefined;
  /** Content at the top of the thread, below its top spacer, scrolling with the messages. */
  threadHeader?: React.ReactNode;
  /** Content under the last row, above the closing spacer, scrolling with the messages. */
  threadFooter?: React.ReactNode;
  /** Told whether the thread is drawn yet: false while it is hidden being placed, true once revealed. */
  onRevealedChange?: ((revealed: boolean) => void) | undefined;
}

export interface MessageListHandle extends VirtuosoHandle {
  resetScrollBreakaway: () => void;
}

/**
 * What a `MessageList` ref holds. Null is a real state, not a placeholder: the
 * empty-list branch renders no `Virtuoso`, so there is nothing to delegate the
 * `VirtuosoHandle` half of the contract to.
 */
type MessageListRef = MessageListHandle | null;

/** Frames after a reveal decision before it is checked again: enough to span the next commit. */
const CONFIRM_FRAMES = 2;

/** Frames a hidden scroller must stay still to count as at rest, about Virtuoso's own 100ms. */
const IDLE_FRAMES = 6;
/** Scrolls to its end a hidden thread may make in one opening: WebKit can clamp one back short. */
const MAX_PINS = 3;

const NO_MODELS: readonly Model[] = [];

/** Where a thread without a heading opens: its last row, at the scroller's end. */
const LAST_ROW = { index: 'LAST', align: 'end' } as const;

/** Whether a thread carries a heading, given as its `threadHeader`. */
function carriesHeading(threadHeader: React.ReactNode): boolean {
  return threadHeader !== undefined && threadHeader !== null;
}

/** Where Virtuoso opens a thread: its first row, from the scroller's top, or its last. */
function openingRow(atTop: boolean): 0 | typeof LAST_ROW {
  return atTop ? 0 : LAST_ROW;
}

function measureAtBottomThreshold(): number {
  return Math.ceil(window.innerHeight * 0.1) + 20;
}

// Read from the scroller itself because both of Virtuoso's signals can run ahead of its scroll: a
// render that blocks the main thread past its settle timer marks the opening row placed while the
// scroller is still at the top, and its at-bottom report is throttled and was last computed on
// estimated heights.
function restsAtItsEnd(scroller: HTMLElement): boolean {
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  return distance <= measureAtBottomThreshold();
}

/** Whether a decision's position still holds: the end, or for a decision at rest, the same place. */
function holdsWhere(
  scroller: HTMLElement,
  decision: Readonly<{ top: number; atEnd: boolean }>
): boolean {
  if (restsAtItsEnd(scroller)) return true;
  return !decision.atEnd && Math.abs(scroller.scrollTop - decision.top) <= 1;
}

/**
 * Whether a thread opening at its top is placed: its rows run past the view, so nothing in view
 * moves as the rest land, or every row is shown, or it has come to rest.
 */
function placedAtTop(scroller: HTMLElement, allRowsShown: boolean, rested: boolean): boolean {
  return !restsAtItsEnd(scroller) || allRowsShown || rested;
}

/**
 * Whether an at-bottom report means the reader has the thread's end in view. At a thread's top
 * the report can be one Virtuoso computed for its seed row, throttled past the reveal, so the
 * revealed scroller is read instead.
 */
function endInView(openedAtTop: boolean, placed: boolean, scroller: HTMLElement | null): boolean {
  if (!openedAtTop) return true;
  return placed && scroller !== null && restsAtItsEnd(scroller);
}

/** Whether a thread's wait on its fonts holds back a reveal decided now. */
function fontsHold(wait: ThreadFontWait | null): boolean {
  return wait?.holds() === true;
}

/** Whether a thread is being placed: mounted with rows, its renderer loaded, and not yet revealed. */
function isPlacing(placed: boolean, messageCount: number, rendererReady: boolean): boolean {
  return !placed && messageCount > 0 && rendererReady;
}

const MessageListInner = forwardRef<MessageListRef, MessageListProps>(function MessageList(
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
    isMessageLink,
    messagesReady = false,
    conversationKey,
    branches,
    activeForkId,
    onOpenBranches,
    threadHeader,
    threadFooter,
    onRevealedChange,
  },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // A thread with a heading opens at its first row with the heading in view; any other thread
  // opens at its end.
  const opensAtTop = carriesHeading(threadHeader);
  // The conversation whose end the reader has had in view since the thread was revealed. A thread
  // with a heading follows its end only from then: Virtuoso, handed any `followOutput` but false,
  // scrolls to the end of a list that grows while it is not there, which would undo the opening.
  const [endReachedIn, setEndReachedIn] = useState<string | undefined | null>(null);
  const followingHeld = opensAtTop && endReachedIn !== conversationKey;
  const userScrolledAwayRef = useRef(false);
  const [isVirtuosoScrolling, setIsVirtuosoScrolling] = useState(false);
  // Whether the list is pinned within Virtuoso's `atBottomThreshold` of the
  // bottom. Exposed as `data-at-bottom` so E2E auto-scroll assertions gate on
  // the app's own settled-at-bottom state instead of reading raw scroll pixels
  // at an instant the post-stream layout (e.g. code-block highlight) is still
  // growing. Starts true: the list mounts pinned at LAST.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // The thread is placed once Virtuoso shows its rows and the scroller is at the thread's end, or
  // Virtuoso's scroll has come to rest since the rows showed; a thread opening at its top, once
  // its rows run past the view, every row shows, or it comes to rest.
  const [placed, setPlaced] = useState(false);
  const placedRef = useRef(false);
  const rowsShownRef = useRef(false);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Whether Virtuoso's scroll has come to rest since it showed the rows.
  const restedRef = useRef(false);
  // How many times this opening has scrolled the hidden thread to its end.
  const pinsRef = useRef(0);
  // Whether this opening is at the thread's top, taken when its rows first show.
  const openedAtTopRef = useRef(false);
  // Whether Virtuoso's last render held every row of the thread.
  const allRowsShownRef = useRef(false);
  // The conversation/fork pair last opened, for the reset on its change below.
  const previousConversationKeyRef = useRef<string | undefined>(conversationKey);
  // A reveal decided but not yet confirmed: where the scroller stood, and whether at its end.
  const decisionRef = useRef<{ top: number; atEnd: boolean } | null>(null);
  const decisionFramesRef = useRef(0);
  // The opening's wait on the fonts its hidden rows asked for, so no late face rewraps a revealed
  // row. Each reveal reads it after the scroller's geometry, whose layout is what asks for them.
  const fontWaitRef = useRef<ThreadFontWait | null>(null);
  // The placements of failed-turn notices already accounted for: each drawn while the thread was
  // hidden, and each placed since. The newest placed is judged once the scroller stands still.
  const seenNoticesRef = useRef(new Set<string>());
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  const noticeStillRef = useRef(STILLNESS_UNCOUNTED);
  const pinToEnd = useCallback((scroller: HTMLElement): void => {
    pinsRef.current += 1;
    restedRef.current = false;
    scroller.scrollTop = scroller.scrollHeight;
  }, []);
  // A thread revealed with its end already in view is following it.
  const revealAtTop = useCallback((scroller: HTMLElement): void => {
    if (!placedAtTop(scroller, allRowsShownRef.current, restedRef.current)) return;
    if (fontsHold(fontWaitRef.current)) return;
    if (restsAtItsEnd(scroller)) setEndReachedIn(previousConversationKeyRef.current);
    placedRef.current = true;
    setPlaced(true);
  }, []);
  const checkPlaced = useCallback((): void => {
    const scroller = scrollerElRef.current;
    if (placedRef.current || decisionRef.current !== null) return;
    if (!rowsShownRef.current || scroller === null) return;
    if (openedAtTopRef.current) {
      revealAtTop(scroller);
      return;
    }
    const atEnd = restsAtItsEnd(scroller);
    if (!atEnd) {
      if (!restedRef.current) return;
      // Virtuoso's opening scroll can end short and still report success: when the rows' first
      // render blocks the main thread, it clamps its target to a list not yet at full height. So
      // the first rest short of the end scrolls there at once; a later one is confirmed first.
      if (pinsRef.current === 0) {
        pinToEnd(scroller);
        return;
      }
    }
    if (fontsHold(fontWaitRef.current)) return;
    // The decision consumes the rest it was taken at; a rest reported while it is confirmed is kept.
    restedRef.current = false;
    decisionRef.current = { top: scroller.scrollTop, atEnd };
    decisionFramesRef.current = 0;
  }, [pinToEnd, revealAtTop]);
  // A layout effect, so the host drops its loading state in the frame the thread is revealed.
  useLayoutEffect(() => {
    onRevealedChange?.(placed);
  }, [placed, onRevealedChange]);
  // Rows rendered before the markdown renderer lands are drawn plain and change height when it
  // does, so Virtuoso mounts, places and reveals the thread only once the module has settled.
  const markdownRendererReady = useMarkdownRendererReady();
  // Where a hidden scroller stood last frame, and for how many frames since it has not moved.
  const idleRef = useRef({ top: -1, frames: 0 });
  // Every frame while a thread is hidden. A decision is confirmed only once the commit that
  // follows it has laid out: WebKit can clamp the scroll after a decision taken at the end, before
  // the first painted frame, back to the list's height before its rows were measured, and two
  // frames span that commit. A position that did not hold is checked again at once, with any rest
  // reported meanwhile. With no decision pending, a scroller that has not moved for as long as
  // Virtuoso waits before it reports a rest counts as at rest, so a thread Virtuoso never scrolls
  // still has a way out of hiding.
  // Confirms a pending decision on its second frame and decides again where it did not hold. A
  // thread that held short of its end scrolls there again while it has pins left, since WebKit can
  // clamp a pin's own scroll back; past the last, it reveals where it rests, since a thread left
  // hidden would never show.
  const confirmDecision = (decision: { top: number; atEnd: boolean }): void => {
    decisionFramesRef.current += 1;
    if (decisionFramesRef.current < CONFIRM_FRAMES) return;
    decisionRef.current = null;
    const scroller = scrollerElRef.current;
    if (scroller === null) return;
    if (!holdsWhere(scroller, decision)) {
      checkPlaced();
      return;
    }
    if (!restsAtItsEnd(scroller) && pinsRef.current < MAX_PINS) {
      pinToEnd(scroller);
      return;
    }
    if (fontsHold(fontWaitRef.current)) return;
    placedRef.current = true;
    setPlaced(true);
  };
  // Counts a hidden scroller that has not moved for as long as Virtuoso waits as at rest.
  const watchStillness = (): void => {
    const scroller = scrollerElRef.current;
    const idle = idleRef.current;
    if (scroller === null || !rowsShownRef.current || restedRef.current || isVirtuosoScrolling) {
      idleRef.current = { top: -1, frames: 0 };
      return;
    }
    const top = Math.round(scroller.scrollTop);
    if (top !== idle.top) {
      idleRef.current = { top, frames: 0 };
      return;
    }
    idle.frames += 1;
    if (idle.frames < IDLE_FRAMES) return;
    idle.frames = 0;
    restedRef.current = true;
    checkPlaced();
  };
  useAnimationFrame(
    () => {
      const decision = decisionRef.current;
      if (decision === null) watchStillness();
      else confirmDecision(decision);
    },
    { respectMotion: false, paused: !isPlacing(placed, messages.length, markdownRendererReady) }
  );

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

  // Monotonic counter of completed stream cycles, owned by `useChatPageState`
  // (incremented on the post-commit "persisting drained to empty" transition,
  // batching-immune — see stream-cycle-activity). Exposed as
  // `data-streams-completed` so E2E tests can capture a baseline before an
  // action and wait for it to advance, avoiding races where the stream finishes
  // faster than a polling assertion can observe `data-streaming-count > 0`.
  const streamsCompleted = useStreamCycleActivityStore((s) => s.streamsCompleted);

  const preInferenceStagesSeen = usePreInferenceActivityStore((s) => s.preInferenceStagesSeen);

  // Reset scroll state when the conversation/fork pair changes. Replaces the
  // parent's `key=` remount, which previously unmounted Virtuoso (and the
  // surrounding chat layout) during the /chat → /chat/{realId} transition,
  // producing a visible blank-frame flash. The ref starts at the first
  // render's pair, whose opening `initialTopMostItemIndex` places. A new pair
  // opens where the thread opens: its top under a heading, its end otherwise.
  useEffect(() => {
    if (previousConversationKeyRef.current === conversationKey) return;
    previousConversationKeyRef.current = conversationKey;
    userScrolledAwayRef.current = false;
    if (opensAtTop) virtuosoRef.current?.scrollTo({ top: 0 });
    else virtuosoRef.current?.scrollToIndex(LAST_ROW);
  }, [conversationKey, opensAtTop]);

  // Re-pin to the latest row when content settles off the bottom while auto-
  // follow is still engaged. After a turn stops streaming, a late growth — the
  // cost true-up badge inflating the final reply, or a send's smooth scroll
  // undershooting under host saturation — can leave the viewport above the
  // bottom, and Virtuoso's followOutput won't recover it (it re-pins on new
  // items, never on in-place growth or a short scroll). Guarded to act only
  // post-stream (followOutput owns the streaming case), never against a user
  // who scrolled away, and never when already pinned, so it converges to the
  // bottom without fighting the user or churning mid-stream.
  useEffect(() => {
    if ((streamingMessageIds?.size ?? 0) > 0) return;
    if (followingHeld || userScrolledAwayRef.current || isAtBottom) return;
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
  }, [messages, streamingMessageIds, isAtBottom, followingHeld]);

  // Must exceed Footer height (10dvh) so scrollToIndex({ index: 'LAST' })
  // lands within the threshold and atBottomStateChange reports true. The footer
  // is in `dvh`, which tracks the live viewport, so a value sampled once at
  // mount stops encoding the relationship after a rotation or a mobile URL-bar
  // collapse. `resize` is the signal: it is the event that accompanies a
  // `window.innerHeight` change. Font scaling and the accessibility widget are
  // CSS-token changes that never move `innerHeight`, so they correctly do not
  // re-measure.
  const [atBottomThreshold, setAtBottomThreshold] = useState(measureAtBottomThreshold);

  useEffect(() => {
    const remeasure = (): void => {
      setAtBottomThreshold(measureAtBottomThreshold());
    };
    window.addEventListener('resize', remeasure);
    return (): void => {
      window.removeEventListener('resize', remeasure);
    };
  }, []);

  const handleIsScrolling = useCallback(
    (scrolling: boolean): void => {
      setIsVirtuosoScrolling(scrolling);
      // Virtuoso reports no scroll as it mounts; at a thread's top, where nothing scrolls it, that
      // is no rest, and the frames the scroller stays still are.
      if (scrolling || !rowsShownRef.current || openedAtTopRef.current) return;
      restedRef.current = true;
      checkPlaced();
    },
    [checkPlaced]
  );

  useImperativeHandle<MessageListRef, MessageListRef>(ref, () => {
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) {
      return null;
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
        previous.removeEventListener('scroll', checkPlaced);
      }
      scrollerElRef.current = el instanceof HTMLElement ? el : null;
      const next = scrollerElRef.current;
      if (next) {
        next.addEventListener('wheel', markUserScroll, { passive: true });
        next.addEventListener('touchmove', markUserScroll, { passive: true });
        next.addEventListener('keydown', handleUserScrollKey);
        // Virtuoso's last move into place is a scroll that may re-render no row.
        next.addEventListener('scroll', checkPlaced, { passive: true });
        // The rows' first layout effect runs before this ref attaches.
        checkPlaced();
      } else {
        // Virtuoso unmounted; the next list it mounts opens from scratch.
        rowsShownRef.current = false;
        placedRef.current = false;
        restedRef.current = false;
        pinsRef.current = 0;
        decisionRef.current = null;
        idleRef.current = { top: -1, frames: 0 };
        fontWaitRef.current?.release();
        fontWaitRef.current = null;
        setPlaced(false);
        setEndReachedIn(null);
        setPendingNotice(null);
      }
    },
    [markUserScroll, handleUserScrollKey, checkPlaced]
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

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean): void => {
      setIsAtBottom(atBottom);
      if (!atBottom && userScrolledRef.current) {
        // Only flag scrolled-away when the user is actively scrolling. A
        // bare `!atBottom` would also fire during streaming when content
        // grows faster than the auto-scroll catches up — a webkit-prone race
        // that previously disengaged followOutput mid-stream.
        userScrolledAwayRef.current = true;
      } else if (
        atBottom &&
        endInView(openedAtTopRef.current, placedRef.current, scrollerElRef.current)
      ) {
        // Always re-engage when we land back at the bottom — whether the user
        // scrolled there or followOutput caught up.
        userScrolledAwayRef.current = false;
        setEndReachedIn(conversationKey);
      }
    },
    [conversationKey]
  );

  const followOutput = useCallback((): boolean => {
    return !userScrolledAwayRef.current;
  }, []);
  const virtuosoFollowOutput = useMemo(
    () => (followingHeld ? false : followOutput),
    [followingHeld, followOutput]
  );

  // ONE catalog read for the whole list, for the same reason {@link RegenerateGate}
  // is read once per list: a query subscription per row sits inside a virtualised
  // item that re-renders on every streaming token.
  const { data: models } = useModels();

  const chatContext = useMemo(
    () =>
      buildChatContext({
        isAuthenticated: isAuthenticated ?? true,
        isLinkGuest: isLinkGuest ?? false,
        isMessageLink: isMessageLink ?? false,
        privilege: callerPrivilege,
        currentUserId,
        isGroupChat: isGroupChat ?? false,
      }),
    [isAuthenticated, isLinkGuest, isMessageLink, callerPrivilege, currentUserId, isGroupChat]
  );
  const rerunScope = rerunGateScope(chatContext, messages[0]?.conversationId, callerPrivilege);
  const [regenerateRefusal, setRegenerateRefusal] = useState<NoticeReason | undefined>();
  // {@link RegenerateGate} is the first child of the list's root in both the empty-thread branch
  // and the thread branch, so it stays mounted when the first message arrives.
  const regenerateGate = rerunScope && (
    <RegenerateGate messages={messages} scope={rerunScope} onRefusal={setRegenerateRefusal} />
  );
  // Whether the viewer may send at all; a trial chat names no privilege and holds no compare turn.
  const canSend = chatContext.privilege !== undefined && canSendMessages(chatContext.privilege);

  const siblingRows = useMemo(() => groupSiblingReplies(messages), [messages]);
  const groups = useMemo(
    () => (isGroupChat ? groupSenderRuns(siblingRows) : null),
    [isGroupChat, siblingRows]
  );

  // O(N) precompute so the render mapper does O(1) lookups per row instead of
  // calling isMultiModelResponse per message (each itself O(N) → O(N²) total).
  const multiModelIds = useMemo(() => getMultiModelMessageIds(messages), [messages]);
  // Regenerating an assistant reply re-sends its parent's text, which a deleted
  // message no longer has, so a reply to one is offered no regenerate.
  const deletedIds = useMemo(
    () => new Set(messages.filter((m) => m.deleted === true).map((m) => m.id)),
    [messages]
  );

  const forkMarks = useMemo(() => forkMarkCounts(branches, activeForkId), [branches, activeForkId]);

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
      if (!isDecryptionFailure(message.content)) decrypted += 1;
    }
    const compareRow = (replies: SiblingReplies): MessageRow => {
      const cells = replies.map((message) => ({
        message,
        isStreaming: streamingMessageIds?.has(message.id) ?? false,
        isError: message.id === errorMessageId || message.errorCode !== undefined,
      }));
      const forkMore = replies
        .map((m) => forkMarks.get(m.id))
        .findLast((more) => more !== undefined);
      return {
        key: replies[0].id,
        message: replies[0],
        replies: cells,
        isStreaming: cells.some((cell) => cell.isStreaming),
        isError: cells.some((cell) => cell.isError),
        ...(forkMore !== undefined && { forkMore }),
      };
    };
    const built: MessageRow[] = groups
      ? groups.map((row) => {
          if (row.kind === 'compare') return compareRow(row.replies);
          const { group } = row;
          const first = group.messages[0];
          const forkMore = group.messages
            .map((m) => forkMarks.get(m.id))
            .findLast((more) => more !== undefined);
          return {
            key: group.id,
            group,
            ...(first !== undefined && { message: first }),
            isStreaming: group.messages.some((m) => streamingMessageIds?.has(m.id) ?? false),
            isError: group.messages.some(
              (m) => m.id === errorMessageId || m.errorCode !== undefined
            ),
            ...(forkMore !== undefined && { forkMore }),
          };
        })
      : siblingRows.map((row) => {
          if (row.kind === 'compare') return compareRow(row.replies);
          const { message } = row;
          const forkMore = forkMarks.get(message.id);
          return {
            key: message.id,
            message,
            isStreaming: streamingMessageIds?.has(message.id) ?? false,
            isError: message.id === errorMessageId || message.errorCode !== undefined,
            ...(forkMore !== undefined && { forkMore }),
          };
        });
    return { rows: built, assistantCount: assistant, costCount: cost, decryptedCount: decrypted };
  }, [groups, siblingRows, messages, streamingMessageIds, errorMessageId, forkMarks]);

  const computeItemKey = useCallback((_index: number, row: MessageRow): string => row.key, []);

  const handleRowsShown = useCallback(
    (count: number): void => {
      if (!rowsShownRef.current) {
        openedAtTopRef.current = opensAtTop;
        fontWaitRef.current = waitForThreadFonts(checkPlaced);
      }
      rowsShownRef.current = true;
      allRowsShownRef.current = count >= rows.length;
      checkPlaced();
    },
    [checkPlaced, opensAtTop, rows.length]
  );

  const listContext = useMemo<ListContext>(
    () => ({ threadHeader, threadFooter, placed, onRowsShown: handleRowsShown }),
    [threadHeader, threadFooter, placed, handleRowsShown]
  );

  useEffect(() => {
    const unseen = unseenNotices(messages, seenNoticesRef.current);
    for (const { placement } of unseen) seenNoticesRef.current.add(placement);
    const newest = unseen.at(-1);
    if (!placed || newest === undefined) return;
    noticeStillRef.current = STILLNESS_UNCOUNTED;
    setPendingNotice(newest.id);
  }, [messages, placed]);

  // A notice is judged only once the scroller has stood still for as long as Virtuoso waits before
  // it reports a rest, so the thread's own follow to its end lands first. One placed out of view is
  // jumped to, since Virtuoso cuts a smooth scroll short as it measures the rows it passes, and the
  // jump leaves the thread's end, so the reader stops following it there.
  const judgeNotice = (id: string): void => {
    const scroller = scrollerElRef.current;
    if (scroller === null) return;
    const step = countStillFrame(noticeStillRef.current, scroller.scrollTop, IDLE_FRAMES);
    noticeStillRef.current = step.still;
    if (!step.rested) return;
    setPendingNotice(null);
    const index = rowIndexHolding(rows, id);
    if (index === -1) return;
    virtuosoRef.current?.scrollIntoView({
      index,
      behavior: 'auto',
      calculateViewLocation: (view) => {
        const location = noticeViewLocation(view);
        if (location !== null) userScrolledAwayRef.current = true;
        return location;
      },
    });
  };
  useAnimationFrame(
    () => {
      if (pendingNotice !== null) judgeNotice(pendingNotice);
    },
    { respectMotion: false, paused: pendingNotice === null }
  );

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
        {regenerateGate}
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
        models,
        modelName,
        onShare,
        onRegenerate,
        onEdit,
        onFork,
        regenerateRefusal,
      }),
    };
  }

  function actionsFor(
    message: Message,
    isStreaming: boolean,
    isError: boolean
  ): ReturnType<typeof resolveMessageActions> {
    const msgContext: MessageContext = {
      message,
      isStreaming,
      isError,
      isMultiModel: multiModelIds.has(message.id),
      canRegenerate:
        !(message.role === 'assistant' && deletedIds.has(message.parentMessageId ?? '')) &&
        canRegenerateMessage(
          messages,
          message.id,
          chatContext.currentUserId ?? '',
          chatContext.isGroupChat
        ),
    };
    return resolveMessageActions(chatContext, msgContext);
  }

  function renderMessageItem(
    message: Message,
    isStreaming: boolean,
    isError: boolean,
    placement: Readonly<{
      group?: MessageGroup | undefined;
      compare?: ComparePresentation | undefined;
    }> = {}
  ): React.JSX.Element | null {
    const { group, compare } = placement;
    return (
      <MessageItem
        message={message}
        allowedActions={actionsFor(message, isStreaming, isError)}
        isStreaming={isStreaming}
        isError={isError}
        {...buildOptionalMessageProps(group)}
        {...(compare !== undefined && { compare })}
      />
    );
  }

  /**
   * A failed or refused turn, drawn as the notice tile in the reply's place: no model tag,
   * no reply body and no action row. Its Regenerate is the reply row's, with its refusal.
   */
  function renderTurnNotice(message: Message, notice: TurnNotice): React.JSX.Element {
    const regenerate = actionsFor(message, false, true).has('regenerate')
      ? onRegenerate
      : undefined;
    return (
      <ChatColumn>
        <div
          data-testid={TEST_IDS.messageItem}
          data-role="assistant"
          data-message-id={message.id}
          data-error="true"
          className={computeContainerClasses(false, false, false)}
        >
          <TurnNoticeView
            placement="tile"
            notice={notice}
            {...(regenerate !== undefined && {
              onRegenerate: (): void => {
                regenerate(message.id);
              },
            })}
            {...(regenerateRefusal !== undefined && { regenerateRefusal })}
          />
        </div>
      </ChatColumn>
    );
  }

  function renderRow(row: MessageRow, message: Message): React.JSX.Element | null {
    const { replies } = row;
    if (replies === undefined && message.turnNotice !== undefined) {
      return renderTurnNotice(message, message.turnNotice);
    }
    if (replies === undefined) {
      return renderMessageItem(message, row.isStreaming, row.isError, { group: row.group });
    }
    return (
      <CompareGroup
        replies={replies.map((cell) => ({
          message: cell.message,
          render: (compare) =>
            renderMessageItem(cell.message, cell.isStreaming, cell.isError, { compare }),
        }))}
        models={models?.models ?? NO_MODELS}
        canSend={canSend}
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
      data-pre-inference-stages-seen={preInferenceStagesSeen}
      data-message-count={messages.length}
      data-decrypted-count={decryptedCount}
      data-rows-count={rows.length}
      data-virtuoso-scrolling={String(isVirtuosoScrolling)}
      data-at-bottom={String(isAtBottom)}
      data-messages-ready={String(messagesReady)}
      className="h-full min-h-0 flex-1"
    >
      {regenerateGate}
      {markdownRendererReady && (
        <Virtuoso<MessageRow, ListContext>
          ref={virtuosoRef}
          context={listContext}
          scrollerRef={handleScrollerRef}
          data={rows}
          initialTopMostItemIndex={openingRow(opensAtTop)}
          // Force-mount the first row before the scroller is measured, so the chat
          // log isn't empty during the WebKit first-paint stall where a
          // percentage-height scroller measures 0px until a ResizeObserver fires.
          // Capped at 1: Virtuoso's initial-paint seed renders `initialItemCount`
          // rows *forward* from the `LAST` anchor (offset `initialItemCount - 1`),
          // so any value >1 reads past the end of `data` and crashes computeItemKey
          // on an undefined row. 1 keeps the seed in bounds (offset 0).
          initialItemCount={1}
          computeItemKey={computeItemKey}
          isScrolling={handleIsScrolling}
          followOutput={virtuosoFollowOutput}
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
            const item = renderRow(row, row.message);
            if (row.forkMore === undefined || onOpenBranches === undefined) return item;
            return (
              <>
                {item}
                <ChatColumn>
                  <div className="pt-6 pb-2">
                    <ForkMark more={row.forkMore} onOpen={onOpenBranches} />
                  </div>
                </ChatColumn>
              </>
            );
          }}
          components={components}
        />
      )}
    </div>
  );
});

// Memoized so a parent re-render that leaves these props referentially stable
// (e.g. a prompt-input keystroke updating sibling state) skips the virtualized
// list entirely. The parent (ChatMainContent) is responsible for keeping the
// callback / array props stable; see chat-main-content.tsx.
export const MessageList = memo(MessageListInner);
