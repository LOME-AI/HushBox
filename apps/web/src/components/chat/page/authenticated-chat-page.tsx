import * as React from 'react';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PRE_CREATION_CONVERSATION_ID, ROUTES, TEST_IDS, displayUsername } from '@hushbox/shared';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import { useAuthenticatedChat } from '@/hooks/chat/use-authenticated-chat';
import { useGroupChat } from '@/hooks/realtime/use-group-chat';
import { useForks } from '@/hooks/chat/forks';
import { conversationQueryOptions } from '@/hooks/chat/chat';
import { useClearConversationNotifications } from '@/hooks/notifications/use-notification-clearing';
import { useAdvanceReadCursor } from '@/hooks/notifications/use-read-cursor';
import { useEpochMaintenance } from '@/hooks/crypto/use-epoch-maintenance';
import { useForkStore } from '@/stores/chat/fork';
import { useChatEditStore } from '@/stores/chat/edit';
import { ForkDialogs, useForkManagement } from '@/components/chat/page/fork-management';
import { EpochIntegrityBanner } from '@/components/chat/page/epoch-integrity-banner';
import { BadEpochsContext } from '@/components/chat/message/bad-epochs-context';
import { GuestBar } from '@/components/chat/share/guest-bar';
import { ShareHead } from '@/components/chat/share/share-head';
import { resolveRegenerateTarget } from '@/lib/chat/regeneration';
import { hasStoredAuth } from '@/lib/auth/client';
import type { FundingSource, MemberPrivilege } from '@hushbox/shared';
import type { Message } from '@/lib/api/api';
import type { PhantomMessage } from '@/hooks/realtime/use-remote-streaming';
import type { GroupChatProps } from '@/components/chat/message/types';
import type { ChatLayoutProps } from '@/components/chat/layout/chat-layout';
import type { EpochVerdict } from '@/lib/crypto/epoch-key-cache';

interface AuthenticatedChatPageProps {
  readonly routeConversationId: string;
  readonly initialForkId?: string | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for disabled submit handler
const NOOP = (): void => {};

// Hoisted so the element — and the props object TanStack's <Navigate> reads — is
// referentially stable across renders. <Navigate> guards re-navigation by
// comparing its props by reference; an inline <Navigate> allocates fresh props
// every render, re-firing navigate on every commit during the async redirect
// window → "Maximum update depth exceeded" on a 404/access-revoked conversation.
const REDIRECT_TO_CHAT = <Navigate to={ROUTES.CHAT} />;

const NO_BAD_EPOCHS: ReadonlySet<number> = new Set<number>();

/** The epochs whose own key failed verification; none until the keychain is judged. */
function badEpochsOf(verdict: EpochVerdict | undefined): ReadonlySet<number> {
  return verdict?.badEpochs ?? NO_BAD_EPOCHS;
}

/** The finish frame's reasoning facts a phantom carries, onto its message. */
function phantomReasoning(
  phantom: PhantomMessage
): Pick<Message, 'reasoningTokens' | 'reasoningEffort'> {
  return {
    ...(phantom.reasoningTokens !== undefined && { reasoningTokens: phantom.reasoningTokens }),
    ...(phantom.reasoningEffort !== undefined && { reasoningEffort: phantom.reasoningEffort }),
  };
}

function buildPhantomMessages(
  remotePhantoms: Map<string, PhantomMessage> | undefined,
  existingMessages: Message[],
  conversationId: string | null
): Message[] {
  if (!remotePhantoms || remotePhantoms.size === 0) return [];
  const existingIds = new Set(existingMessages.map((m) => m.id));
  const result: Message[] = [];
  for (const [id, phantom] of remotePhantoms) {
    if (existingIds.has(id)) continue;
    result.push({
      id,
      /* v8 ignore next -- phantoms only exist for an active group conversation, so conversationId is non-null here; the ?? '' only satisfies the nullable type */
      conversationId: conversationId ?? '',
      role: phantom.senderType === 'user' ? 'user' : 'assistant',
      content: phantom.content,
      createdAt: '',
      ...(phantom.senderId !== undefined && { senderId: phantom.senderId }),
      ...(phantom.modelName !== undefined && { modelName: phantom.modelName }),
      ...(phantom.awaitingStoredRow === true && { awaitingStoredRow: true }),
      ...phantomReasoning(phantom),
    });
  }
  return result;
}

function findRemoteStreamingIds(
  remotePhantoms: Map<string, PhantomMessage> | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!remotePhantoms) return ids;
  for (const [id, phantom] of remotePhantoms) {
    if (phantom.senderType === 'assistant' && phantom.awaitingStoredRow !== true) ids.add(id);
  }
  return ids;
}

function resolveConversationId(
  routeConversationId: string,
  realConversationId: string | null
): string | null {
  return routeConversationId === PRE_CREATION_CONVERSATION_ID
    ? realConversationId
    : routeConversationId;
}

function combineWithPhantoms(baseMessages: Message[], phantoms: Message[]): Message[] {
  if (phantoms.length === 0) return baseMessages;
  return [...baseMessages, ...phantoms];
}

/**
 * The conversation's messages with other members' live tiles after them. A tile
 * whose stored row is already among the messages is left out, so the stored row
 * takes the tile's place under the same id.
 */
export function messagesWithPhantoms(
  baseMessages: Message[],
  remotePhantoms: Map<string, PhantomMessage> | undefined,
  conversationId: string | null
): Message[] {
  return combineWithPhantoms(
    baseMessages,
    buildPhantomMessages(remotePhantoms, baseMessages, conversationId)
  );
}

interface ForkItem {
  id: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

interface ForkUrlStateArgs {
  routeConversationId: string;
  initialForkId: string | undefined;
  activeForkId: string | null;
  forksList: ForkItem[];
  setActiveFork: (id: string | null) => void;
  /**
   * False on a share link: its route carries no fork param, and writing one
   * would leave it for the member-only chat route.
   */
  writesUrl: boolean;
}

// Owns the active fork ↔ URL relationship. The `?fork=` search param is the
// source of truth on load (so deep links and page reloads restore the right
// fork); the store carries it for the rest of the session.
function useForkUrlState({
  routeConversationId,
  initialForkId,
  activeForkId,
  forksList,
  setActiveFork,
  writesUrl,
}: ForkUrlStateArgs): void {
  const navigate = useNavigate();
  const seedResolvedRef = React.useRef(false);
  // Whether a fork has been active at any point this session. Distinguishes the
  // pre-seed load window (never activated → a deep-linked `?fork=` must survive)
  // from a fork that was selected and then deleted (activated → its now-stale
  // param must be cleared).
  const hasActivatedForkRef = React.useRef(false);

  // Route the fork search param through the router (the single writer); a raw
  // history.replaceState races TanStack Router's own search parsing. Called with
  // no argument clears the param.
  const replaceForkSearch = React.useCallback(
    (fork?: string): void => {
      void navigate({
        to: ROUTES.CHAT_ID,
        params: { id: routeConversationId },
        search: { fork },
        replace: true,
      });
    },
    [navigate, routeConversationId]
  );

  React.useEffect(() => {
    // Seed the active fork from the URL `?fork=` param, and keep the Main fallback
    // from running until that seed has taken hold in the store. Latching on the
    // first render raced the store update: a re-render arriving before
    // setActiveFork was reflected fell through to the fallback and clobbered the
    // deep-linked fork with Main.
    if (!seedResolvedRef.current) {
      if (initialForkId && activeForkId === null) {
        setActiveFork(initialForkId);
        return;
      }
      // The store now holds a value (the seed took, or a real selection already
      // existed), or there was nothing to seed — either way the fallback is
      // unblocked from here on.
      seedResolvedRef.current = true;
    }
    // Fallback: forks exist but nothing is selected (no `?fork=` on load, or the
    // active fork was just deleted) → default to Main (earliest createdAt).
    if (activeForkId === null && forksList.length >= 2) {
      const sorted = forksList.toSorted(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (sorted[0]) {
        setActiveFork(sorted[0].id);
      }
    }
  }, [initialForkId, activeForkId, forksList, setActiveFork]);

  React.useEffect(() => {
    // Mirror the active fork into the URL. The route stays the single writer.
    if (!writesUrl || !seedResolvedRef.current) {
      return;
    }
    if (activeForkId !== null) {
      hasActivatedForkRef.current = true;
      // Already reflected by the URL the page loaded with — nothing to write.
      if (activeForkId === initialForkId) {
        return;
      }
      replaceForkSearch(activeForkId);
      return;
    }
    // No active fork. Never clear during the pre-seed load window — that would
    // strip a deep-linked `?fork=` before the seed reads it. Only clear once a
    // fork has actually been active and then went away (last fork deleted →
    // conversation reverted to linear), leaving a stale param behind.
    if (!hasActivatedForkRef.current) {
      return;
    }
    replaceForkSearch();
  }, [writesUrl, initialForkId, activeForkId, replaceForkSearch]);
}

// Holds the latest `value` in a ref without writing or reading it during render.
// useInsertionEffect commits the update before passive/layout effects and event
// handlers run, so reads from those contexts always see the current value.
function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

// Holds the meta line's height until the member list arrives, so the thread below it stays put.
const META_PLACEHOLDER = '\u00A0';

/** Who shared the conversation and how many sit in it, counted as the members pane counts. */
function shareMeta(members: GroupChatProps['members'] | undefined): string {
  const owner = members?.find((member) => member.privilege === 'owner');
  if (members === undefined || owner?.username == null) return META_PLACEHOLDER;
  const noun = members.length === 1 ? 'member' : 'members';
  return `Shared by ${displayUsername(owner.username)} · ${String(members.length)} ${noun}`;
}

/** Default callerPrivilege to 'read' during loading for link guests to prevent notification flash. */
function resolveGuestPrivilege(
  isLinkGuest: boolean,
  callerPrivilege: MemberPrivilege | undefined
): MemberPrivilege | undefined {
  if (!isLinkGuest) return callerPrivilege;
  return callerPrivilege ?? 'read';
}

interface ReadOnlyGuestSlots {
  /** The header's title: none for a read-only guest, whose shared head carries it. */
  readonly headerTitle: string | undefined;
  readonly threadHeader: React.ReactNode;
  readonly composerSlot: React.ReactNode;
}

/**
 * What a read-only link guest sees in the chat's place: the shared head at the top of the
 * thread and the guest bar in the composer's. Both are memoised, because the message list
 * they reach is.
 */
function useReadOnlyGuestSlots(
  isLinkGuest: boolean,
  callerPrivilege: MemberPrivilege | undefined,
  title: string | undefined,
  groupChat: GroupChatProps | undefined
): ReadOnlyGuestSlots {
  const isReadOnlyGuest =
    isLinkGuest && resolveGuestPrivilege(isLinkGuest, callerPrivilege) === 'read';
  const shareTitle = title ?? '';
  const meta = shareMeta(groupChat?.members);
  // On a share link the session is masked and never restored, so the device's sign-in
  // marker is the one sign that the visitor holds an account here.
  const [signedIn] = React.useState(hasStoredAuth);
  const threadHeader = React.useMemo(
    () =>
      isReadOnlyGuest ? (
        <ChatColumn>
          <ShareHead title={shareTitle} meta={meta} />
        </ChatColumn>
      ) : undefined,
    [isReadOnlyGuest, shareTitle, meta]
  );
  const composerSlot = React.useMemo(
    () => (isReadOnlyGuest ? <GuestBar signedIn={signedIn} /> : undefined),
    [isReadOnlyGuest, signedIn]
  );
  return { headerTitle: isReadOnlyGuest ? undefined : title, threadHeader, composerSlot };
}

export function AuthenticatedChatPage({
  routeConversationId,
  initialForkId,
  privateKeyOverride,
}: AuthenticatedChatPageProps): React.JSX.Element {
  const { editingMessageId, startEditing, clearEditing } = useChatEditStore();

  const { activeForkId, setActiveFork } = useForkStore();

  const chat = useAuthenticatedChat({ routeConversationId, activeForkId, privateKeyOverride });
  const conversationId = resolveConversationId(routeConversationId, chat.realConversationId);
  const groupChat = useGroupChat(conversationId, chat.callerId, chat.displayTitle);
  useClearConversationNotifications(conversationId);
  useAdvanceReadCursor(conversationId);
  useEpochMaintenance(conversationId);

  const forksQueryId = conversationId ?? '';
  const { data: forks } = useForks(forksQueryId);
  // The conversation read arrives before its member list, so the header can hold a
  // group's member strip row from first paint.
  const { data: memberCount } = useQuery({
    ...conversationQueryOptions(forksQueryId),
    select: (detail) => detail.memberCount,
    enabled: forksQueryId !== '',
  });
  const forksList = React.useMemo(() => forks ?? [], [forks]);

  useForkUrlState({
    routeConversationId,
    initialForkId,
    activeForkId,
    forksList,
    setActiveFork,
    writesUrl: privateKeyOverride == null,
  });

  const fm = useForkManagement(conversationId, forksList, activeForkId, setActiveFork);

  // useAuthenticatedChat rebuilds handleSend / handleRegenerate every render
  // (their useCallback deps include the per-render `state` object), so reading
  // the latest values through refs — only inside the event handlers below, never
  // during render — keeps these wrappers referentially stable. That stability is
  // what lets the memoized ChatMainContent → MessageList skip re-rendering on a
  // prompt-input keystroke. setInputValue and the edit-store actions are already
  // stable, so handlers that only use those depend on them directly.
  const chatRef = useLatestRef(chat);
  const setInputValue = chat.state.setInputValue;

  const handleRegenerate = React.useCallback(
    (messageId: string): void => {
      const current = chatRef.current;
      const { targetMessageId, action, replaceAssistantId } = resolveRegenerateTarget(
        current.messages,
        messageId
      );
      current.handleRegenerate(targetMessageId, action, undefined, replaceAssistantId);
    },
    [chatRef]
  );

  const handleEdit = React.useCallback(
    (messageId: string, content: string): void => {
      startEditing(messageId, content);
      setInputValue(content);
    },
    [startEditing, setInputValue]
  );

  const handleCancelEdit = React.useCallback((): void => {
    clearEditing();
    setInputValue('');
  }, [clearEditing, setInputValue]);

  const handleEditSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      const current = chatRef.current;
      if (!editingMessageId) {
        current.handleSend(fundingSource);
        return;
      }
      current.handleRegenerate(editingMessageId, 'edit', current.state.inputValue);
      clearEditing();
    },
    [editingMessageId, clearEditing, chatRef]
  );

  const isLinkGuest = privateKeyOverride != null;
  const { headerTitle, threadHeader, composerSlot } = useReadOnlyGuestSlots(
    isLinkGuest,
    chat.callerPrivilege,
    chat.displayTitle,
    groupChat
  );
  const remotePhantoms = groupChat?.remoteStreamingMessages;
  const messagesWithRemoteTiles = React.useMemo(
    () => messagesWithPhantoms(chat.messages, remotePhantoms, conversationId),
    [remotePhantoms, conversationId, chat.messages]
  );

  // Fork filtering is already applied inside useAuthenticatedChat (via forkFilteredDecrypted
  // passed to mergeMessages). Optimistic messages are appended after fork filtering, so they
  // remain visible during streaming. No need to re-apply fork filter here.

  const remoteStreamingIds = React.useMemo(
    () => findRemoteStreamingIds(remotePhantoms),
    [remotePhantoms]
  );

  const effectiveStreamingIds =
    chat.state.streamingMessageIds.size > 0 ? chat.state.streamingMessageIds : remoteStreamingIds;

  // Persistence-tracking has no remote-streaming equivalent (group-chat
  // phantoms originate on another client, where their persistence is the
  // remote sender's concern). Local data-streaming-count therefore reflects
  // only this tab's in-flight commits — that's what local tests care about.
  const effectivePersistingIds = chat.state.persistingMessageIds;

  if (chat.renderState.type === 'redirecting' || chat.renderState.type === 'not-found') {
    if (isLinkGuest) {
      return (
        <div
          className="flex h-full items-center justify-center"
          data-testid={TEST_IDS.sharedConversationError}
        >
          <p className="text-muted-foreground">This shared link is no longer available.</p>
        </div>
      );
    }
    return REDIRECT_TO_CHAT;
  }

  // Loading and ready render one element tree: a remount between them would rebuild the
  // composer's band and reset its measured height while the page settles, shifting it.
  const sharedLayoutProps = {
    onInputChange: chat.state.setInputValue,
    isAuthenticated: !isLinkGuest,
    isLinkGuest,
    promptInputRef: chat.promptInputRef,
    conversationId: conversationId ?? undefined,
    groupChat,
    memberCount,
    threadHeader,
    composerSlot,
  } satisfies Partial<ChatLayoutProps>;
  const isLoading = chat.renderState.type === 'loading';
  const layoutProps: ChatLayoutProps = isLoading
    ? {
        ...sharedLayoutProps,
        title: chat.renderState.title,
        messages: [],
        streamingMessageIds: new Set<string>(),
        persistingMessageIds: new Set<string>(),
        inputValue: '',
        onSubmit: NOOP,
        inputDisabled: true,
        isProcessing: false,
        historyCharacters: 0,
        isDecrypting: true,
        callerPrivilege: resolveGuestPrivilege(isLinkGuest, chat.callerPrivilege),
      }
    : {
        ...sharedLayoutProps,
        title: headerTitle,
        messages: messagesWithRemoteTiles,
        branchMessages: chat.branchMessages,
        streamingMessageIds: effectiveStreamingIds,
        persistingMessageIds: effectivePersistingIds,
        inputValue: chat.state.inputValue,
        onSubmit: handleEditSubmit,
        onSubmitUserOnly: chat.handleSendUserOnly,
        inputDisabled: chat.inputDisabled,
        isProcessing: chat.isStreaming,
        onStop: chat.handleStop,
        onQueue: chat.onQueueMessage,
        queueCount: chat.queueCount,
        queueFull: chat.queueFull,
        queuedMessages: chat.queuedMessages,
        onCancelQueued: chat.onCancelQueued,
        historyCharacters: chat.historyCharacters,
        errorMessageId: chat.errorMessageId,
        callerPrivilege: chat.callerPrivilege,
        forks: forksList,
        activeForkId,
        onForkSelect: fm.handleForkSelect,
        onForkRename: fm.handleForkRename,
        onForkDelete: fm.handleForkDelete,
        onRegenerate: handleRegenerate,
        onEdit: handleEdit,
        onFork: fm.handleForkFromMessage,
        isEditing: editingMessageId !== null,
        onCancelEdit: handleCancelEdit,
        messagesReady: chat.messagesReady,
      };

  return (
    <BadEpochsContext value={badEpochsOf(chat.epochVerdict)}>
      <EpochIntegrityBanner
        verdict={isLoading ? undefined : chat.epochVerdict}
        conversationId={conversationId}
        isLinkGuest={isLinkGuest}
      />
      <ChatLayout {...layoutProps} />
      <ForkDialogs fm={fm} />
    </BadEpochsContext>
  );
}
