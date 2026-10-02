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
  ChatRequestError,
  type RegenerateStreamRequest,
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
import { useChatErrorStore, MAIN_FORK_KEY } from '@/stores/chat/error';
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
import {
  BALANCE_STALE_REFUSAL_CODES,
  handleTurnError,
  turnErrorContent,
} from '@/hooks/chat/turn-error';
import { useTurnStreamCallbacks } from '@/hooks/chat/use-turn-stream-callbacks';
import { useMessageQueueDrain } from '@/hooks/chat/use-message-queue-drain';
import { useCreateConversationFlow } from '@/hooks/chat/use-create-conversation-flow';
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
  // stop control aborts, so unmount does no run teardown.
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
    convId: string;
    userMessageData: { content: string };
    messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
    fundingSource: FundingSource;
    forkId?: string;
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
      const { convId, userMessageData, messagesForInference, fundingSource, forkId } = params;
      const callbacks = createOptimisticStreamCallbacks(convId);
      const { models } = await startStream(
        {
          conversationId: convId,
          modality: activeModality,
          models: selectedModels.map((m) => m.id),
          userMessage: userMessageData,
          messagesForInference,
          fundingSource,
          webSearchEnabled,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(customInstructions != null && { customInstructions }),
          ...(forkId != null && { forkId }),
          ...buildModalityConfigPayload(activeModality, imageConfig, videoConfig, audioConfig),
        },
        {
          ...callbacks,
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
        }
      );
      // run-finished settled server-side: costs and media render from the
      // persisted rows this refetch loads (billed cost is never on the wire).
      await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

      return { models };
    },
    [
      createOptimisticStreamCallbacks,
      startStream,
      selectedModels,
      webSearchEnabled,
      reasoningEffort,
      customInstructions,
      state,
      queryClient,
      activeModality,
      imageConfig,
      videoConfig,
      audioConfig,
    ]
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

  /**
   * Send one specific message text through the run path and resolve once it has
   * FULLY settled: `{ ok: true }` when the run committed, `{ ok: false }` when it
   * refused/failed (error already surfaced). Takes explicit `content` rather than
   * reading `inputValue`, so the drain can send a dequeued message without the
   * `setInputValue`-then-send race (setState is async and may not have applied).
   */
  const executeSend = React.useCallback(
    async (
      content: string,
      convId: string,
      fundingSource: FundingSource
    ): Promise<{ ok: boolean }> => {
      // Read the live message set (see `inferenceSourceRef`), not this callback's
      // creation-time closure. On a drained N+1 this synchronous read lands on the
      // microtask after N resolved, while N's optimistic turn is still committed —
      // so it carries messages 1..N for history and parentage.
      const { forkFilteredDecrypted: currentDecrypted, optimisticMessages: currentOptimistic } =
        inferenceSourceRef.current;

      // Resolve parent: last message in the current view (fork-filtered + optimistic)
      const allCurrentMessages = [...currentDecrypted, ...currentOptimistic];
      const lastMessage = allCurrentMessages.at(-1);
      // On its local key until the run start names the id the server stores it under.
      const optimistic = {
        row: createUserMessage(convId, content, callerId, lastMessage?.id ?? null),
      };
      addOptimisticMessage(optimistic.row);

      // Build messagesForInference from fork-filtered decrypted messages + new user message
      const messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
        ...currentDecrypted.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...currentOptimistic.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user' as const, content },
      ];

      // This turn's assistant tile ids, captured from the `start` event and
      // replaced on a re-key. Scoped locally (not via a shared ref) so an
      // overlapping send can't make this turn's error cleanup remove the other
      // turn's tiles.
      const placeholderIds: string[] = [];

      try {
        const { models: modelResults } = await executeStream({
          convId,
          userMessageData: { content },
          messagesForInference,
          fundingSource,
          onUserMessageId: (userMessageId) => {
            optimistic.row = adoptOptimisticUserRow(optimistic.row, userMessageId, {
              addOptimisticMessage,
              removeOptimisticMessage,
            });
          },
          onPlaceholders: (ids) => placeholderIds.splice(0, placeholderIds.length, ...ids),
          ...(activeForkId != null && { forkId: activeForkId }),
        });
        // A tile that errored has no stored row to replace it, so it stays.
        dropRowsWithoutStoredTwin(convId, [
          optimistic.row.id,
          ...modelResults.filter((mr) => !mr.errorCode).map((mr) => mr.assistantMessageId),
        ]);
        return { ok: true };
      } catch (error: unknown) {
        if (error instanceof ChatRequestError && BALANCE_STALE_REFUSAL_CODES.has(error.code)) {
          await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }
        handleTurnError(error, content, errorForkKey, promptInputRef);
        requestEpochMaintenanceOnRefusal(convId, error);

        // Stream threw after `start` fired: drop the AI placeholders that
        // `onStart` added optimistically. Without this, each placeholder
        // renders as an invisible empty bubble whose action toolbar floats
        // above the chat-error tile.
        for (const placeholderId of placeholderIds) {
          removeOptimisticMessage(placeholderId);
        }

        removeOptimisticMessage(optimistic.row.id);
        state.stopStreaming(placeholderIds);
        return { ok: false };
      }
    },
    [
      callerId,
      addOptimisticMessage,
      removeOptimisticMessage,
      dropRowsWithoutStoredTwin,
      executeStream,
      activeForkId,
      errorForkKey,
      state,
      queryClient,
      promptInputRef,
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

  const handleRegenerate = React.useCallback(
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

      // Regenerating on this fork — clear any prior error tile for this fork
      // before kicking off the new request.
      useChatErrorStore.getState().clearError(errorForkKey);

      // Build messagesForInference from fork-filtered decrypted messages up to the target
      const messagesForInference = buildMessagesForRegeneration(
        allMsgs,
        targetMessageId,
        action,
        editedContent
      );

      applyPrune({
        allMsgs,
        targetMessageId,
        action,
        replaceAssistantId,
        conversationId: realConversationId,
        setRetryPrunedIds,
        setLocalMessages,
        queryClient,
      });

      // An edit's replacement row, on its local key until the run start names its id.
      const edited = {
        row:
          action === 'edit'
            ? addEditedUserOptimistic({
                allMsgs,
                targetMessageId,
                userContent,
                conversationId: realConversationId,
                callerId,
                addOptimisticMessage,
              })
            : null,
      };

      const modality = inferRegenerateModality(targetMessageId, allMsgs);
      const models = resolveRegenerateModels(
        allMsgs,
        targetMessageId,
        replaceAssistantId,
        getPrimaryModel(selectedModels).id
      );

      const request: RegenerateStreamRequest = {
        conversationId: realConversationId,
        targetMessageId,
        action,
        modality,
        models,
        ...(replaceAssistantId !== undefined && { replaceAssistantId }),
        userMessage: { content: userContent },
        messagesForInference,
        fundingSource: 'personal_balance',
        ...(activeForkId != null && { forkId: activeForkId }),
        ...(webSearchEnabled && { webSearchEnabled }),
        ...(reasoningEffort !== undefined && { reasoningEffort }),
        ...(customInstructions != null && { customInstructions }),
        ...buildModalityConfigPayload(modality, imageConfig, videoConfig, audioConfig),
      };

      // Adopt the multi-model send's optimistic callback set. Single-model
      // regenerate is structurally a special case of N=1, so it reuses the
      // same per-tile routing without divergent code paths.
      const callbacks = createOptimisticStreamCallbacks(realConversationId);
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
          await startRegenerateStream(request, {
            ...callbacks,
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

          await queryClient.invalidateQueries({
            queryKey: chatKeys.conversation(realConversationId),
          });
          setRetryPrunedIds(new Set());
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          dropRowsWithoutStoredTwin(realConversationId, [
            ...placeholderIds,
            ...(edited.row === null ? [] : [edited.row.id]),
          ]);
        } catch (error: unknown) {
          state.stopStreaming(placeholderIds);

          if (error instanceof ChatRequestError && BALANCE_STALE_REFUSAL_CODES.has(error.code)) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleTurnError(error, userContent, errorForkKey, promptInputRef);
          requestEpochMaintenanceOnRefusal(realConversationId, error);

          await queryClient.invalidateQueries({
            queryKey: chatKeys.conversation(realConversationId),
          });
          setRetryPrunedIds(new Set());

          for (const id of placeholderIds) removeOptimisticMessage(id);
          if (edited.row !== null) removeOptimisticMessage(edited.row.id);
        }
      })();
    },
    [
      realConversationId,
      activeForkId,
      errorForkKey,
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
      startRegenerateStream,
      removeOptimisticMessage,
      dropRowsWithoutStoredTwin,
      addOptimisticMessage,
      callerId,
      createOptimisticStreamCallbacks,
      state,
      queryClient,
      promptInputRef,
      setRetryPrunedIds,
      setLocalMessages,
    ]
  );

  /**
   * Explicit user stop — plain HTTP by design (a WS-blocked user can always
   * abort a paid run). The server settles + BILLS the partial; the streamed
   * partial stays rendered and the run-finished refetch loads the persisted
   * rows. `stopped:false` (run already over) is a benign no-op.
   *
   * A refusal is shown, never logged away: the run keeps spending until it is
   * aborted, so a caller who is told nothing believes it stopped. The sentence
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

  // Counted over the trimmed replay, because that is what the send carries and
  // what the server counts: an assistant turn's stored reasoning never reaches
  // the provider, so it must never enter the budget basis either. A turn-notice
  // row is display only: the send never carries it.
  const historyCharacters = React.useMemo(() => {
    const carried = allMessages.filter((m) => m.turnNotice === undefined);
    return historyCharacterCount(stripReplayHistory(carried));
  }, [allMessages]);

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

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      // Ahead of `prepareMessageInput`, which clears the composer: a message the
      // hold refuses stays where the user typed it.
      if (isInstructionsReadUnresolved) return;
      const prepared = prepareMessageInput();
      if (!prepared) {
        return;
      }
      void (async () => {
        const result = await executeSend(prepared.content, prepared.convId, fundingSource);
        // A user send that fully settles drains the next queued message. On
        // failure the queue is preserved (the drain does not start), so nothing
        // is lost and nothing auto-sends behind a failure.
        if (result.ok) {
          onUserSendSettled();
        }
      })();
    },
    [isInstructionsReadUnresolved, prepareMessageInput, executeSend, onUserSendSettled]
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
