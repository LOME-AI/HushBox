import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  historyCharacterCount,
  stripReplayHistory,
  PRE_CREATION_CONVERSATION_ID,
  ROUTES,
  type FundingSource,
  type MemberPrivilege,
} from '@hushbox/shared';
import { useIsMobile, toast } from '@hushbox/ui';
import { createUserMessage } from '@/lib/chat/messages';
import {
  buildMessagesForRegeneration,
  inferRegenerateModality,
  resolveRegenerateModels,
} from '@/lib/chat/regeneration';
import {
  computeRenderState,
  isReadLoading,
  mergeMessages,
  buildModalityConfigPayload,
  resolveUserContent,
  computeDisplayTitle,
  resolveQueryId,
  resolveCallerId,
  checkDecryptionPending,
  computeInputDisabled,
  deriveMessagesReady,
  type RenderState,
  type RegenerateAction,
} from '@/lib/chat/auth-chat-helpers';
import { useChatPageState } from '@/hooks/chat/use-chat-page';
import {
  useChatStream,
  type AuthenticatedStreamRequest,
  type InferenceMessage,
  type ModelResult,
  type StartEventData,
} from '@/hooks/chat/use-chat-stream';
import { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import { useConversation, useMessages, useCreateConversation, chatKeys } from '@/hooks/chat/chat';

import { usePendingChatStore } from '@/stores/chat/pending-chat';
import { type QueuedMessage } from '@/stores/chat/message-queue';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import { useChatErrorStore, MAIN_FORK_KEY, type FailedTurnRetry } from '@/stores/chat/error';
import { billingKeys } from '@/hooks/billing/billing';
import {
  subscribe as epochCacheSubscribe,
  getSnapshot as epochCacheSnapshot,
  getEpochVerdict,
  type EpochVerdict,
} from '@/lib/crypto/epoch-key-cache';
import { useAuthStore, selectInstructionsReadUnresolved } from '@/lib/auth/auth';
import { useDecryptedMessages } from '@/hooks/crypto/use-decrypted-messages';
import { requestEpochMaintenanceOnRefusal } from '@/hooks/crypto/use-epoch-maintenance';
import { useForks } from '@/hooks/chat/forks';
import { useForkMessages } from '@/hooks/chat/use-fork-messages';
import { idempotentHeaders } from '@/lib/api/idempotent-mutation';
import { client, fetchJson } from '@/lib/api-client';
import { turnErrorContent } from '@/hooks/chat/turn-error';
import { useTurnStreamCallbacks } from '@/hooks/chat/use-turn-stream-callbacks';
import { useMessageQueueDrain } from '@/hooks/chat/use-message-queue-drain';
import { useCreateConversationFlow } from '@/hooks/chat/use-create-conversation-flow';
import {
  dispatchFailedTurnRetry,
  mergeStoredIds,
  recordFailedTurn,
  useFailedTurnReconcile,
} from '@/hooks/chat/failed-turn-retry';
import {
  addEditedUserOptimistic,
  adoptOptimisticUserRow,
  applyPrune,
} from '@/hooks/chat/optimistic-turn-rows';
import type { Message, MessageResponse } from '@/lib/api/api';
import type { PromptInputRef } from '@/components/chat/message/types';

export { resolveDrainDecision } from '@/hooks/chat/use-message-queue-drain';
export { shouldStreamFirstTurn } from '@/hooks/chat/use-create-conversation-flow';

interface UseAuthenticatedChatInput {
  readonly routeConversationId: string;
  readonly activeForkId?: string | null | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

interface UseAuthenticatedChatResult {
  readonly state: ReturnType<typeof useChatPageState>;
  readonly renderState: RenderState;
  readonly messages: Message[];
  readonly branchMessages: readonly Message[];
  readonly messagesReady: boolean;
  readonly historyCharacters: number;
  readonly displayTitle: string | undefined;
  /** Also true while the conversation's keys wait on a rotation or failed verification. */
  readonly inputDisabled: boolean;
  /** This client's verdict on the conversation's keys; undefined until its keychain is verified. */
  readonly epochVerdict: EpochVerdict | undefined;
  readonly isStreaming: boolean;
  readonly handleSend: (fundingSource: FundingSource) => void;
  readonly handleSendUserOnly: () => void;
  readonly handleRegenerate: (
    targetMessageId: string,
    action: RegenerateAction,
    editedContent?: string,
    replaceAssistantId?: string
  ) => void;
  readonly handleStop: () => void;
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly errorMessageId: string | undefined;
  readonly realConversationId: string | null;
  readonly callerId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  /** Queued messages for the active conversation, oldest first (drives the pills). */
  readonly queuedMessages: QueuedMessage[];
  /** Enqueue a message on the active conversation (composer's `onQueue`). */
  readonly onQueueMessage: (text: string) => void;
  /** Remove a queued message by id (pill cancel). */
  readonly onCancelQueued: (id: string) => void;
  /** Number of queued messages on the active conversation. */
  readonly queueCount: number;
  /** Whether the active conversation's queue is at capacity. */
  readonly queueFull: boolean;
}

/**
 * The composer is also closed while the conversation's keys wait on a rotation
 * or failed verification: the server refuses every encryption to an epoch
 * awaiting rotation, and a bad rotation's current key is one no honest member
 * should write under.
 */
function isInputDisabled(disabledBySeat: boolean, verdict: EpochVerdict | undefined): boolean {
  return disabledBySeat || verdict?.rotationPending === true || verdict?.rotation === 'bad';
}

type SendRetry = Extract<FailedTurnRetry, { kind: 'send' }>;
type RegenerateRetry = Extract<FailedTurnRetry, { kind: 'regenerate' }>;

/** The ids of a turn's tiles as a run start keyed them. */
function tileIdsOf(data: StartEventData): string[] {
  return data.models.map((m) => m.assistantMessageId);
}

export function useAuthenticatedChat({
  routeConversationId,
  activeForkId,
  privateKeyOverride,
}: UseAuthenticatedChatInput): UseAuthenticatedChatResult {
  const state = useChatPageState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const activeRef = React.useRef(true);
  React.useEffect(() => {
    activeRef.current = routeConversationId === PRE_CREATION_CONVERSATION_ID;
    return () => {
      activeRef.current = false;
    };
  }, [routeConversationId]);

  const isCreateMode = routeConversationId === PRE_CREATION_CONVERSATION_ID;

  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
  const pendingFundingSource = usePendingChatStore((s) => s.pendingFundingSource);
  const clearPendingMessage = usePendingChatStore((s) => s.clearPendingMessage);

  const [realConversationId, setRealConversationId] = React.useState<string | null>(
    isCreateMode ? null : routeConversationId
  );
  const [localMessages, setLocalMessages] = React.useState<Message[]>([]);
  const [localTitle, setLocalTitle] = React.useState<string | null>(null);
  const [retryPrunedIds, setRetryPrunedIds] = React.useState<ReadonlySet<string>>(new Set());

  const optimistic = useOptimisticMessages();
  const { optimisticMessages, addOptimisticMessage, removeOptimisticMessage } = optimistic;

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const imageConfig = useModelStore((state) => state.imageConfig);
  const videoConfig = useModelStore((state) => state.videoConfig);
  const audioConfig = useModelStore((state) => state.audioConfig);
  // Single source of truth for web-search state (see useWebSearch). In the
  // authenticated chat `active === preferred`, so this is behavior-preserving.
  const { active: webSearchEnabled } = useWebSearch();
  // Reasoning selection model-clamped AND lowered to what the payer can fund
  // (see useReasoningEffort); undefined = the field stays off the wire and the
  // turn is reasoning-free.
  const { effective: reasoningEffort } = useReasoningEffort();
  const { isStreaming, startStream, startRegenerateStream, stopRun } =
    useChatStream('authenticated');
  // Scope the error subscription to the currently-active fork (or 'main' for
  // linear / no-fork conversations). Switching forks reads a different slot,
  // so an error that occurred on Main no longer leaks onto Fork 1's view.
  const errorForkKey = activeForkId ?? MAIN_FORK_KEY;
  const chatError = useChatErrorStore((s) => s.errorsByFork[errorForkKey] ?? null);
  const createConversation = useCreateConversation();
  const createConversationRef = React.useRef(createConversation.mutateAsync);
  React.useEffect(() => {
    createConversationRef.current = createConversation.mutateAsync;
  });
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const authUserId = useAuthStore((s) => s.user?.id);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  // A turn built from the value alone drops a standing instruction the server
  // has no other way to obtain — the blob is encrypted to the account key. This
  // hook holds `handleSend` and `handleRegenerate` on it; `executeSend`, which
  // it hands to the queue drain, carries no hold of its own and is held instead
  // by the composer gate the drain re-resolves before every drained send.
  const isInstructionsReadUnresolved = useAuthStore(selectInstructionsReadUnresolved);

  const queryId = resolveQueryId(realConversationId);
  const conversationQuery = useConversation(queryId);
  const conversation = conversationQuery.data;
  const isConversationLoading = isReadLoading(conversationQuery);

  const callerId = resolveCallerId(conversation?.callerId, authUserId);
  const messagesQuery = useMessages(queryId);
  const apiMessages = messagesQuery.data;
  const isMessagesLoading = isReadLoading(messagesQuery);
  const decryptedApiMessages = useDecryptedMessages(
    realConversationId,
    apiMessages,
    privateKeyOverride
  );
  const { data: forks } = useForks(queryId);

  const forkFilteredDecrypted = useForkMessages(
    decryptedApiMessages,
    forks ?? [],
    activeForkId ?? null
  );

  const localMessagesRef = React.useRef<Message[]>([]);
  React.useEffect(() => {
    localMessagesRef.current = localMessages;
  }, [localMessages]);

  const conversationIdRef = React.useRef<string>('');

  // An optimistic row the stored history now holds is shown as the stored row
  // (see `mergeMessages`), so it is dropped only after that render: dropping it
  // first would unmount the row element between the two.
  React.useEffect(() => {
    const storedIds = new Set(decryptedApiMessages.map((m) => m.id));
    for (const m of optimisticMessages) {
      if (storedIds.has(m.id)) removeOptimisticMessage(m.id);
    }
  }, [decryptedApiMessages, optimisticMessages, removeOptimisticMessage]);

  /**
   * Drops the named rows of a settled turn that the refetched history does not
   * hold, since nothing will replace them. The rows it does hold stay until the
   * stored rows render in their place.
   */
  const dropRowsWithoutStoredTwin = React.useCallback(
    (convId: string, rowIds: readonly string[]): void => {
      const stored = queryClient.getQueryData<MessageResponse[]>(chatKeys.messages(convId)) ?? [];
      const storedIds = new Set(stored.map((m) => m.id));
      for (const id of rowIds) {
        if (!storedIds.has(id)) removeOptimisticMessage(id);
      }
    },
    [queryClient, removeOptimisticMessage]
  );

  // A transport disconnect never cancels a run — the server completes,
  // persists, and bills it (the answer is there on return). Only the explicit
  // stop control stops a run from the client, so unmount does no run teardown.
  React.useEffect(() => {
    return () => {
      useChatErrorStore.getState().clearAll();
    };
  }, []);

  const { recordSmartTiles, localMessageHandlers, createOptimisticStreamCallbacks } =
    useTurnStreamCallbacks({
      state,
      conversationIdRef,
      setLocalMessages,
      activeModality,
      imageConfig,
      videoConfig,
      optimistic,
    });

  interface ExecuteStreamParams {
    request: AuthenticatedStreamRequest;
    /** The object the turn's Idempotency-Key is minted from. */
    turn: object;
    /**
     * Receives the user message id the run start named, before any tile exists,
     * and again when a same-key re-execution names a new one.
     */
    onUserMessageId: (userMessageId: string | null) => void;
    /**
     * Receives this turn's assistant tile ids when `start` arrives, and the ids
     * that replace them when a same-key re-execution names new ones, so the
     * caller can scope its own error cleanup to the tiles the turn now holds.
     */
    onPlaceholders: (assistantMessageIds: string[]) => void;
  }

  const executeStream = React.useCallback(
    async (params: ExecuteStreamParams): Promise<{ models: ModelResult[] }> => {
      const convId = params.request.conversationId;
      const callbacks = createOptimisticStreamCallbacks(convId);
      const { models } = await startStream(params.request, {
        ...callbacks,
        turn: params.turn,
        onStart: (data: StartEventData) => {
          params.onUserMessageId(data.userMessageId);
          callbacks.onStart(data);
          params.onPlaceholders(data.models.map((m) => m.assistantMessageId));
        },
        onRekey: (data) => {
          params.onUserMessageId(data.userMessageId);
          callbacks.onRekey(data);
          params.onPlaceholders(tileIdsOf(data));
        },
      });
      // run-finished settled server-side: costs and media render from the
      // persisted rows this refetch loads (billed cost is never on the wire).
      await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

      return { models };
    },
    [createOptimisticStreamCallbacks, startStream, queryClient]
  );

  useCreateConversationFlow({
    isCreateMode,
    pendingMessage,
    pendingFundingSource,
    accountPrivateKey,
    clearPendingMessage,
    callerId,
    activeRef,
    conversationIdRef,
    createConversationRef,
    setLocalMessages,
    setLocalTitle,
    setRealConversationId,
    navigate,
    queryClient,
    state,
    startStream,
    selectedModels,
    webSearchEnabled,
    reasoningEffort,
    customInstructions,
    isInstructionsReadUnresolved,
    activeModality,
    imageConfig,
    videoConfig,
    audioConfig,
    localMessageHandlers,
    recordSmartTiles,
    addOptimisticMessage,
  });

  /** Validate input, clear it, refocus, and return trimmed content + conversationId (or null). */
  const prepareMessageInput = React.useCallback((): {
    content: string;
    convId: string;
  } | null => {
    const content = state.inputValue.trim();
    if (!content || !realConversationId) {
      return null;
    }

    // User typed a new message on the active fork — clear that fork's
    // previous error tile (if any) before sending.
    useChatErrorStore.getState().clearError(errorForkKey);

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    return { content, convId: realConversationId };
  }, [state, realConversationId, errorForkKey, isMobile, promptInputRef]);

  // Live snapshot of the message set that composes a turn's inference history.
  // `executeSend` reads it AT CALL TIME rather than from its creation-time
  // closure: a drained send runs inside a long-lived loop that spans multiple
  // settles, so the closure arrays would be frozen at loop-start and each drained
  // message N+1 would omit messages 1..N and their assistant answers.
  //
  // Ordering that makes the ref read safe for N+1 (load-bearing): when message N's
  // `executeSend` resolves, the drain loop resumes on a MICROTASK and synchronously
  // reads this ref at the top of N+1's `executeSend`. At that read the ref still
  // carries message N's OPTIMISTIC turn (user + streamed assistant): React flushes
  // the promise-batched optimistic-tile removal and refetch as state updates on a
  // later macrotask (React commit), which cannot interleave into the microtask-only
  // hop from N resolving to N+1's synchronous read. So N+1 reads the pre-removal
  // committed snapshot, which includes message N. useLayoutEffect keeps the ref
  // current for ordinary renders; it is NOT what orders the ref ahead of the loop's
  // next microtask. Caveat: this relies on the removal render not flushing
  // synchronously before that continuation — updating the ref synchronously with
  // optimistic removal would open a removed-but-not-yet-refetched window.
  const inferenceSourceRef = React.useRef({ forkFilteredDecrypted, optimisticMessages });
  React.useLayoutEffect(() => {
    inferenceSourceRef.current = { forkFilteredDecrypted, optimisticMessages };
  }, [forkFilteredDecrypted, optimisticMessages]);

  const failureContext = React.useMemo(
    () => ({ forkKey: errorForkKey, queryClient, promptInputRef }),
    [errorForkKey, queryClient]
  );

  /**
   * Runs a send's request under its turn and resolves once it has FULLY settled:
   * `{ ok: true }` when the run committed, `{ ok: false }` when it refused or
   * failed, the failure recorded with the request and turn a retry re-posts.
   */
  const runSend = React.useCallback(
    async (
      retry: SendRetry,
      earlierStoredIds: readonly string[] = []
    ): Promise<{ ok: boolean }> => {
      const convId = retry.request.conversationId;
      // On its local key until the run start names the id the server stores it under.
      const optimistic = { row: retry.question };
      addOptimisticMessage(optimistic.row);

      // This turn's assistant tile ids, captured from the `start` event and
      // replaced on a re-key. Scoped locally (not via a shared ref) so an
      // overlapping send can't make this turn's error cleanup remove the other
      // turn's tiles.
      const placeholderIds: string[] = [];

      try {
        const { models: modelResults } = await executeStream({
          request: retry.request,
          turn: retry.turn,
          onUserMessageId: (userMessageId) => {
            optimistic.row = adoptOptimisticUserRow(optimistic.row, userMessageId, {
              addOptimisticMessage,
              removeOptimisticMessage,
            });
          },
          onPlaceholders: (ids) => placeholderIds.splice(0, placeholderIds.length, ...ids),
        });
        // A tile that errored has no stored row to replace it, so it stays.
        dropRowsWithoutStoredTwin(convId, [
          optimistic.row.id,
          ...modelResults.filter((mr) => !mr.errorCode).map((mr) => mr.assistantMessageId),
        ]);
        return { ok: true };
      } catch (error: unknown) {
        // The question is drawn from the record above its notice (see
        // `mergeMessages`), never kept as an optimistic row the next send would
        // carry in its history.
        // The question keeps the id it was first drawn under, which the first
        // turn's local row also carries, so a retry's new id never draws it twice.
        const storedIds = mergeStoredIds(earlierStoredIds, [optimistic.row.id, ...placeholderIds]);
        await recordFailedTurn(error, { retry, storedIds }, failureContext);

        // Stream threw after `start` fired: drop the AI placeholders that
        // `onStart` added optimistically. Without this, each placeholder
        // renders as an invisible empty bubble whose action toolbar floats
        // above the chat-error tile.
        for (const placeholderId of placeholderIds) {
          removeOptimisticMessage(placeholderId);
        }

        removeOptimisticMessage(optimistic.row.id);
        state.stopStreaming(placeholderIds);
        // A run the client saw fail may have settled; the reconcile reads this refetch.
        await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
        return { ok: false };
      }
    },
    [
      addOptimisticMessage,
      removeOptimisticMessage,
      dropRowsWithoutStoredTwin,
      executeStream,
      failureContext,
      state,
      queryClient,
    ]
  );

  /**
   * Send one specific message text through the run path and resolve once it has
   * FULLY settled (see `runSend`). Takes explicit `content` rather than
   * reading `inputValue`, so the drain can send a dequeued message without the
   * `setInputValue`-then-send race (setState is async and may not have applied).
   */
  const executeSend = React.useCallback(
    (content: string, convId: string, fundingSource: FundingSource): Promise<{ ok: boolean }> => {
      // Read the live message set (see `inferenceSourceRef`), not this callback's
      // creation-time closure. On a drained N+1 this synchronous read lands on the
      // microtask after N resolved, while N's optimistic turn is still committed —
      // so it carries messages 1..N for history and parentage.
      const { forkFilteredDecrypted: currentDecrypted, optimisticMessages: currentOptimistic } =
        inferenceSourceRef.current;
      const allCurrentMessages = [...currentDecrypted, ...currentOptimistic];
      const messagesForInference: InferenceMessage[] = [
        ...allCurrentMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content },
      ];
      return runSend({
        kind: 'send',
        request: {
          conversationId: convId,
          modality: activeModality,
          models: selectedModels.map((m) => m.id),
          userMessage: { content },
          messagesForInference,
          fundingSource,
          webSearchEnabled,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(customInstructions != null && { customInstructions }),
          ...(activeForkId != null && { forkId: activeForkId }),
          ...buildModalityConfigPayload(activeModality, imageConfig, videoConfig, audioConfig),
        },
        turn: {},
        // Parented to the last message in the current view (fork-filtered + optimistic).
        question: createUserMessage(
          convId,
          content,
          callerId,
          allCurrentMessages.at(-1)?.id ?? null
        ),
      });
    },
    [
      runSend,
      callerId,
      activeForkId,
      activeModality,
      selectedModels,
      webSearchEnabled,
      reasoningEffort,
      customInstructions,
      imageConfig,
      videoConfig,
      audioConfig,
    ]
  );

  const handleSendUserOnly = React.useCallback(() => {
    const prepared = prepareMessageInput();
    if (!prepared) {
      return;
    }
    const { content, convId } = prepared;

    const allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages];
    const lastMsg = allCurrentMessages.at(-1);
    const optimisticUserMessage = createUserMessage(convId, content, callerId, lastMsg?.id ?? null);
    addOptimisticMessage(optimisticUserMessage);

    void (async () => {
      try {
        // The server mints the message id, so the send dedups on its key.
        const send = {};
        await fetchJson(
          client.chat[':conversationId'].message.$post(
            {
              param: { conversationId: convId },
              json: {
                content,
                // Chain onto the branch being viewed so the message stays on that
                // fork after refetch, instead of being parented onto Main.
                ...(activeForkId != null && { forkId: activeForkId }),
              },
            },
            idempotentHeaders(send)
          )
        );
        await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
        removeOptimisticMessage(optimisticUserMessage.id);
      } catch (error: unknown) {
        console.error('User-only message failed:', error);
        requestEpochMaintenanceOnRefusal(convId, error);
        removeOptimisticMessage(optimisticUserMessage.id);
        promptInputRef.current?.focus();
      }
    })();
  }, [
    prepareMessageInput,
    addOptimisticMessage,
    removeOptimisticMessage,
    queryClient,
    forkFilteredDecrypted,
    optimisticMessages,
    activeForkId,
    state,
    realConversationId,
  ]);

  /**
   * Runs a regenerate or edit request under its turn: the replies it replaces are
   * hidden while it runs and come back if it fails, and the failure is recorded
   * with the request and turn a retry re-posts.
   */
  const runRegenerate = React.useCallback(
    (retry: RegenerateRetry, earlierStoredIds: readonly string[] = []): void => {
      const { request } = retry;
      const conversationId = request.conversationId;
      const allMsgs = [...forkFilteredDecrypted, ...optimisticMessages];

      // Regenerating on this fork — clear any prior error tile for this fork
      // before kicking off the new request.
      useChatErrorStore.getState().clearError(errorForkKey);

      applyPrune({
        allMsgs,
        targetMessageId: request.targetMessageId,
        action: request.action,
        replaceAssistantId: request.replaceAssistantId,
        conversationId,
        setRetryPrunedIds,
        setLocalMessages,
        queryClient,
      });

      // An edit's replacement row, on its local key until the run start names its id.
      const edited = {
        row:
          request.action === 'edit'
            ? addEditedUserOptimistic({
                allMsgs,
                targetMessageId: request.targetMessageId,
                userContent: request.userMessage.content,
                conversationId,
                callerId,
                addOptimisticMessage,
              })
            : null,
      };

      // Adopt the multi-model send's optimistic callback set. Single-model
      // regenerate is structurally a special case of N=1, so it reuses the
      // same per-tile routing without divergent code paths.
      const callbacks = createOptimisticStreamCallbacks(conversationId);
      // Populated synchronously inside onStart (which fires during the await
      // below, before stream completion). Safe to read post-await — the
      // stream resolves strictly after onStart, so the array is fully
      // populated by then.
      const placeholderIds: string[] = [];
      const adoptEditedRow = (userMessageId: string | null): void => {
        if (edited.row === null) return;
        edited.row = adoptOptimisticUserRow(edited.row, userMessageId, {
          addOptimisticMessage,
          removeOptimisticMessage,
        });
      };

      void (async () => {
        try {
          const { models: results } = await startRegenerateStream(request, {
            ...callbacks,
            turn: retry.turn,
            onStart: (data) => {
              adoptEditedRow(data.userMessageId);
              callbacks.onStart(data);
              for (const m of data.models) placeholderIds.push(m.assistantMessageId);
            },
            onRekey: (data) => {
              adoptEditedRow(data.userMessageId);
              callbacks.onRekey(data);
              placeholderIds.splice(0, placeholderIds.length, ...tileIdsOf(data));
            },
          });

          state.stopStreaming(placeholderIds);

          await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
          setRetryPrunedIds(new Set());
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          // A column that errored has no stored row to replace it, so it stays.
          const errored = new Set(
            results.filter((r) => r.errorCode).map((r) => r.assistantMessageId)
          );
          dropRowsWithoutStoredTwin(conversationId, [
            ...placeholderIds.filter((id) => !errored.has(id)),
            ...(edited.row === null ? [] : [edited.row.id]),
          ]);
        } catch (error: unknown) {
          state.stopStreaming(placeholderIds);
          // A retry's question is its stored anchor; an edit's is the text the user
          // wrote, kept from the attempt that first drew it.
          const question = retry.question ?? edited.row;
          const latest = [...(edited.row === null ? [] : [edited.row.id]), ...placeholderIds];
          await recordFailedTurn(
            error,
            {
              retry: { ...retry, question },
              storedIds: mergeStoredIds(earlierStoredIds, latest),
            },
            failureContext
          );

          await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
          setRetryPrunedIds(new Set());

          for (const id of placeholderIds) removeOptimisticMessage(id);
          if (edited.row !== null) removeOptimisticMessage(edited.row.id);
        }
      })();
    },
    [
      errorForkKey,
      forkFilteredDecrypted,
      optimisticMessages,
      startRegenerateStream,
      removeOptimisticMessage,
      dropRowsWithoutStoredTwin,
      addOptimisticMessage,
      callerId,
      createOptimisticStreamCallbacks,
      state,
      queryClient,
      failureContext,
      setRetryPrunedIds,
      setLocalMessages,
    ]
  );

  const regenerateTurn = React.useCallback(
    (
      targetMessageId: string,
      action: RegenerateAction,
      editedContent?: string,
      replaceAssistantId?: string
    ) => {
      if (!realConversationId) return;
      // Regenerate reaches the turn builder without passing the composer's send
      // control, so the instruction hold is stated here as well as there.
      if (isInstructionsReadUnresolved) return;

      const allMsgs = [...forkFilteredDecrypted, ...optimisticMessages];

      // null when the anchor's decrypted content isn't ready (a refetch is
      // re-decrypting). Bail before any state mutation rather than POST empty
      // content, which the server rejects (min(1)) as a failed turn.
      const userContent = resolveUserContent(action, editedContent, allMsgs, targetMessageId);
      if (userContent === null) return;

      const modality = inferRegenerateModality(targetMessageId, allMsgs);
      runRegenerate({
        kind: 'regenerate',
        request: {
          conversationId: realConversationId,
          targetMessageId,
          action,
          modality,
          models: resolveRegenerateModels(
            allMsgs,
            targetMessageId,
            replaceAssistantId,
            getPrimaryModel(selectedModels).id
          ),
          ...(replaceAssistantId !== undefined && { replaceAssistantId }),
          userMessage: { content: userContent },
          // Fork-filtered decrypted messages up to the target.
          messagesForInference: buildMessagesForRegeneration(
            allMsgs,
            targetMessageId,
            action,
            editedContent
          ),
          fundingSource: 'personal_balance',
          ...(activeForkId != null && { forkId: activeForkId }),
          ...(webSearchEnabled && { webSearchEnabled }),
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(customInstructions != null && { customInstructions }),
          ...buildModalityConfigPayload(modality, imageConfig, videoConfig, audioConfig),
        },
        turn: {},
        question: null,
      });
    },
    [
      realConversationId,
      activeForkId,
      forkFilteredDecrypted,
      optimisticMessages,
      isInstructionsReadUnresolved,
      selectedModels,
      webSearchEnabled,
      reasoningEffort,
      customInstructions,
      imageConfig,
      videoConfig,
      audioConfig,
      runRegenerate,
    ]
  );

  /**
   * Explicit user stop — plain HTTP by design (a WS-blocked user can always
   * stop a paid run). The server starts nothing new, lets the work in flight
   * finish, and settles what the run produced; the streamed text stays rendered
   * and the run-finished refetch loads the persisted rows.
   * `stopped:false` (run already over) is a benign no-op.
   *
   * A refusal is shown, never logged away: the run keeps spending until
   * something stops it, so a caller who is told nothing believes it stopped. The sentence
   * comes from the same wire-code mapping a failed turn uses. A toast rather
   * than the chat-error tile because that tile is keyed to a failed user
   * message and offers to retry it, and a stop has neither.
   */
  const handleStop = React.useCallback(() => {
    if (!realConversationId) return;
    void (async (): Promise<void> => {
      try {
        await stopRun(realConversationId);
      } catch (error) {
        toast.error(turnErrorContent(error).content);
      }
    })();
  }, [realConversationId, stopRun]);

  const primaryModelId = getPrimaryModel(selectedModels).id;

  const allMessages = React.useMemo(() => {
    const merged = mergeMessages({
      isCreateMode,
      realConversationId,
      localMessages,
      decryptedApiMessages: forkFilteredDecrypted,
      optimisticMessages,
      chatError,
      primaryModelId,
    });
    if (retryPrunedIds.size > 0) {
      return merged.filter((m) => !retryPrunedIds.has(m.id));
    }
    return merged;
  }, [
    isCreateMode,
    realConversationId,
    localMessages,
    forkFilteredDecrypted,
    optimisticMessages,
    chatError,
    primaryModelId,
    retryPrunedIds,
  ]);

  // Counted over the rows `executeSend` builds the next send's history from, as
  // the trimmed replay the server counts: an assistant turn's stored reasoning
  // never reaches the provider. A turn-notice row and a failed first turn's
  // local row are display only, so neither enters the budget basis.
  const historyCharacters = React.useMemo(
    () =>
      historyCharacterCount(stripReplayHistory([...forkFilteredDecrypted, ...optimisticMessages])),
    [forkFilteredDecrypted, optimisticMessages]
  );

  const isDecryptionPending = checkDecryptionPending(
    isCreateMode,
    apiMessages?.length ?? 0,
    decryptedApiMessages.length
  );

  const renderState = React.useMemo(
    () =>
      computeRenderState({
        isCreateMode,
        pendingMessage,
        localMessagesLength: localMessages.length,
        conversation,
        isConversationLoading,
        isMessagesLoading,
        isDecryptionPending,
      }),
    [
      isCreateMode,
      pendingMessage,
      localMessages.length,
      conversation,
      isConversationLoading,
      isMessagesLoading,
      isDecryptionPending,
    ]
  );

  React.useEffect(() => {
    if (renderState.type === 'redirecting') {
      void navigate({ to: ROUTES.CHAT });
    }
  }, [renderState.type, navigate]);

  const epochCacheVersion = React.useSyncExternalStore(epochCacheSubscribe, epochCacheSnapshot);

  const displayTitle = React.useMemo(
    () => computeDisplayTitle(localTitle, conversation, realConversationId),
    [conversation, realConversationId, localTitle, epochCacheVersion]
  );
  const callerPrivilege = conversation?.callerPrivilege;
  // Read on every render: the cache subscription above re-renders this hook
  // whenever a verdict lands.
  const epochVerdict = getEpochVerdict(queryId);
  const inputDisabled = isInputDisabled(
    computeInputDisabled(isCreateMode, realConversationId, callerPrivilege),
    epochVerdict
  );

  const errorMessageId: string | undefined = chatError?.id;

  const messagesReady = deriveMessagesReady(
    isCreateMode,
    isConversationLoading,
    isDecryptionPending
  );

  const {
    queuedMessages,
    onQueueMessage,
    onCancelQueued,
    queueCount,
    queueFull,
    onUserSendSettled,
  } = useMessageQueueDrain({
    realConversationId,
    historyCharacters,
    callerPrivilege,
    reasoningEffort,
    isStreaming,
    state,
    executeSend,
  });

  const sendAndDrain = React.useCallback(
    (send: () => Promise<{ ok: boolean }>): void => {
      void (async () => {
        const result = await send();
        // A user send that fully settles drains the next queued message. On
        // failure the queue is preserved (the drain does not start), so nothing
        // is lost and nothing auto-sends behind a failure.
        if (result.ok) {
          onUserSendSettled();
        }
      })();
    },
    [onUserSendSettled]
  );

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      // Ahead of `prepareMessageInput`, which clears the composer: a message the
      // hold refuses stays where the user typed it.
      if (isInstructionsReadUnresolved) return;
      const prepared = prepareMessageInput();
      if (!prepared) {
        return;
      }
      sendAndDrain(() => executeSend(prepared.content, prepared.convId, fundingSource));
    },
    [isInstructionsReadUnresolved, prepareMessageInput, sendAndDrain, executeSend]
  );

  useFailedTurnReconcile(chatError, errorForkKey, decryptedApiMessages);

  /**
   * Regenerate on a turn notice re-posts the failed turn's own request under its
   * own turn's key, through the executor it first ran through, so the server's
   * key row decides: a turn that settled after all replays and is never stored
   * or billed twice, and the original models and settings are re-asked.
   */
  const handleRegenerate = React.useCallback(
    (
      targetMessageId: string,
      action: RegenerateAction,
      editedContent?: string,
      replaceAssistantId?: string
    ): void => {
      if (chatError?.id !== targetMessageId) {
        regenerateTurn(targetMessageId, action, editedContent, replaceAssistantId);
        return;
      }
      useChatErrorStore.getState().clearError(errorForkKey);
      dispatchFailedTurnRetry(chatError.failedTurn, {
        send: (retry, storedIds) => {
          sendAndDrain(() => runSend(retry, storedIds));
        },
        regenerate: runRegenerate,
      });
    },
    [chatError, regenerateTurn, errorForkKey, sendAndDrain, runSend, runRegenerate]
  );

  return {
    state,
    renderState,
    messages: allMessages,
    branchMessages: decryptedApiMessages,
    messagesReady,
    historyCharacters,
    displayTitle,
    inputDisabled,
    epochVerdict,
    isStreaming,
    handleSend,
    handleSendUserOnly,
    handleRegenerate,
    handleStop,
    promptInputRef,
    errorMessageId,
    realConversationId,
    callerId,
    callerPrivilege,
    queuedMessages,
    onQueueMessage,
    onCancelQueued,
    queueCount,
    queueFull,
  };
}
