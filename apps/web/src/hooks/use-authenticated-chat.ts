import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import {
  createUserMessage,
  createAssistantMessage,
  appendTokenToMessage,
} from '@/lib/chat-messages';
import { processStartEvent } from '@/lib/multi-model-stream';
import { buildMessagesForRegeneration } from '@/lib/chat-regeneration';
import { useChatPageState } from '@/hooks/use-chat-page';
import {
  useChatStream,
  BalanceReservedError,
  BillingMismatchError,
  ContextCapacityError,
  type RegenerateStreamRequest,
  type ModelResult,
} from '@/hooks/use-chat-stream';
import type { StartEventData } from '@/lib/sse-client';
import { useOptimisticMessages } from '@/hooks/use-optimistic-messages';
import {
  useConversation,
  useMessages,
  useCreateConversation,
  chatKeys,
  DECRYPTING_TITLE,
} from '@/hooks/chat';

import { usePendingChatStore } from '@/stores/pending-chat';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useSearchStore } from '@/stores/search';
import { useChatErrorStore, createChatError } from '@/stores/chat-error';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { billingKeys } from '@/hooks/billing';
import {
  createFirstEpoch,
  getPublicKeyFromPrivate,
  encryptMessageForStorage,
  decryptMessage,
} from '@hushbox/crypto';
import {
  setEpochKey,
  getEpochKey,
  subscribe as epochCacheSubscribe,
  getSnapshot as epochCacheSnapshot,
} from '@/lib/epoch-key-cache';
import {
  generateChatTitle,
  toBase64,
  fromBase64,
  friendlyErrorMessage,
  ERROR_CODE_CHAT_STREAM_FAILED,
  ROUTES,
  type FundingSource,
  type MemberPrivilege,
} from '@hushbox/shared';
import type { Message } from '@/lib/api';
import type { MessageResponse } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth';
import { useDecryptedMessages } from '@/hooks/use-decrypted-messages';
import { useForks } from '@/hooks/forks';
import { useForkMessages } from '@/hooks/use-fork-messages';
import { client, fetchJson } from '@/lib/api-client';

interface UseAuthenticatedChatInput {
  readonly routeConversationId: string;
  readonly activeForkId?: string | null | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

type RenderState =
  | { readonly type: 'redirecting' }
  | { readonly type: 'not-found' }
  | { readonly type: 'loading'; readonly title?: string | undefined }
  | { readonly type: 'ready' };

type RegenerateAction = 'retry' | 'edit';

interface UseAuthenticatedChatResult {
  readonly state: ReturnType<typeof useChatPageState>;
  readonly renderState: RenderState;
  readonly messages: Message[];
  readonly historyCharacters: number;
  readonly displayTitle: string | undefined;
  readonly inputDisabled: boolean;
  readonly isStreaming: boolean;
  readonly handleSend: (fundingSource: FundingSource) => void;
  readonly handleSendUserOnly: () => void;
  readonly handleRegenerate: (
    targetMessageId: string,
    action: RegenerateAction,
    editedContent?: string
  ) => void;
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly errorMessageId: string | undefined;
  readonly realConversationId: string | null;
  readonly callerId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
}

export interface ComputeRenderStateParams {
  isCreateMode: boolean;
  pendingMessage: string | null;
  localMessagesLength: number;
  conversation: { title: string } | undefined;
  isConversationLoading: boolean;
  isMessagesLoading: boolean;
  isDecryptionPending: boolean;
}

export function shouldRedirect(
  isCreateMode: boolean,
  pendingMessage: string | null,
  localMessagesLength: number
): boolean {
  return isCreateMode && !pendingMessage && localMessagesLength === 0;
}

export function computeRenderState(params: ComputeRenderStateParams): RenderState {
  const {
    isCreateMode,
    pendingMessage,
    localMessagesLength,
    conversation,
    isConversationLoading,
    isMessagesLoading,
  } = params;

  if (shouldRedirect(isCreateMode, pendingMessage, localMessagesLength)) {
    return { type: 'redirecting' };
  }

  if (isCreateMode) {
    return { type: 'ready' };
  }

  if (!conversation && !isConversationLoading) {
    return { type: 'not-found' };
  }

  if (isConversationLoading || isMessagesLoading) {
    // During create→existing transition, local messages are still available —
    // skip the loading state to avoid a flash of the decrypting indicator.
    if (localMessagesLength > 0) {
      return { type: 'ready' };
    }
    return { type: 'loading', title: DECRYPTING_TITLE };
  }

  // API returned messages but decryption hasn't completed yet (key chain loading).
  // Stay in loading state to show "Decrypting..." instead of a blank page.
  if (params.isDecryptionPending) {
    return { type: 'loading', title: DECRYPTING_TITLE };
  }

  return { type: 'ready' };
}

function attachCostToMessage(
  setter: React.Dispatch<React.SetStateAction<Message[]>>,
  messageId: string,
  cost: string
): void {
  setter((previous) => previous.map((m) => (m.id === messageId ? { ...m, cost } : m)));
}

function navigateIfActive(
  activeRef: React.RefObject<boolean>,
  navigate: ReturnType<typeof useNavigate>,
  route: string,
  params?: Record<string, string>
): void {
  if (activeRef.current) {
    void navigate({
      to: route,
      ...(params && { params }),
      ...(params && { replace: true }),
    });
  }
}

function resolveUserContent(
  action: RegenerateAction,
  editedContent: string | undefined,
  allMessages: Message[],
  targetMessageId: string
): string {
  if (action === 'edit' && editedContent) return editedContent;
  return allMessages.find((m) => m.id === targetMessageId)?.content ?? '';
}

export function pruneMessagesAfterTarget(
  allMessages: Message[],
  targetMessageId: string,
  setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>
): void {
  const targetIndex = allMessages.findIndex((m) => m.id === targetMessageId);
  if (targetIndex === -1) return;
  const idsToKeep = new Set(allMessages.slice(0, targetIndex + 1).map((m) => m.id));
  setLocalMessages((previous) => previous.filter((m) => idsToKeep.has(m.id)));
}

interface ChatError {
  id: string;
  content: string;
}

interface MergeMessagesInput {
  isCreateMode: boolean;
  realConversationId: string | null;
  localMessages: Message[];
  decryptedApiMessages: Message[];
  optimisticMessages: Message[];
  chatError: ChatError | null;
}

function mergeMessages(input: MergeMessagesInput): Message[] {
  let messages: Message[];
  if (input.isCreateMode || !input.realConversationId) {
    messages = input.localMessages;
  } else {
    const apiMessageIds = new Set(input.decryptedApiMessages.map((m) => m.id));
    const pendingOptimistic = input.optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    messages = [...input.decryptedApiMessages, ...pendingOptimistic];
    if (messages.length === 0 && input.localMessages.length > 0) {
      messages = input.localMessages;
    }
  }
  if (input.chatError) {
    messages = [
      ...messages,
      {
        id: input.chatError.id,
        conversationId: input.realConversationId ?? '',
        role: 'assistant',
        content: input.chatError.content,
        createdAt: new Date().toISOString(),
      },
    ];
  }
  return messages;
}

function startStreamingIfNeeded(
  assistantMessageIds: string[],
  state: { startStreaming: (ids: string[]) => void }
): void {
  if (assistantMessageIds.length > 0) {
    state.startStreaming(assistantMessageIds);
  }
}

function attachCostsToMessages(
  models: ModelResult[],
  setter: React.Dispatch<React.SetStateAction<Message[]>>
): void {
  for (const mr of models) {
    if (mr.cost && mr.cost !== '0') {
      attachCostToMessage(setter, mr.assistantMessageId, mr.cost);
    }
  }
}

function computeDisplayTitle(
  localTitle: string | null,
  conversation: { title: string; titleEpochNumber: number } | undefined,
  realConversationId: string | null
): string | undefined {
  if (localTitle) return localTitle;
  if (!conversation?.title || !realConversationId) return;
  const epochKey = getEpochKey(realConversationId, conversation.titleEpochNumber);
  if (!epochKey) return DECRYPTING_TITLE;
  try {
    return decryptMessage(epochKey, fromBase64(conversation.title));
  } catch {
    return 'Encrypted conversation';
  }
}

function resolveQueryId(realConversationId: string | null): string {
  return realConversationId ?? '';
}

function resolveCallerId(
  conversationCallerId: string | undefined,
  authUserId: string | undefined
): string | undefined {
  return conversationCallerId ?? authUserId;
}

function checkDecryptionPending(
  isCreateMode: boolean,
  apiMessageCount: number,
  decryptedCount: number
): boolean {
  return !isCreateMode && apiMessageCount > 0 && decryptedCount === 0;
}

function computeInputDisabled(
  isCreateMode: boolean,
  realConversationId: string | null,
  callerPrivilege: MemberPrivilege | undefined
): boolean {
  return (isCreateMode && !realConversationId) || callerPrivilege === 'read';
}

function handleRegenerationError(
  error: unknown,
  failedContent: string,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  if (error instanceof BillingMismatchError || error instanceof BalanceReservedError) {
    useChatErrorStore.getState().setError(
      createChatError({
        content: friendlyErrorMessage(error.code),
        retryable: true,
        failedContent,
      })
    );
  } else if (error instanceof ContextCapacityError) {
    useChatErrorStore.getState().setError(
      createChatError({
        content: friendlyErrorMessage(error.code),
        retryable: false,
        failedContent,
      })
    );
  } else {
    console.error('Regeneration failed:', error);
    useChatErrorStore.getState().setError(
      createChatError({
        content: friendlyErrorMessage(ERROR_CODE_CHAT_STREAM_FAILED),
        retryable: false,
        failedContent,
      })
    );
    promptInputRef.current?.focus();
  }
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
  const creationStartedRef = React.useRef(false);
  const activeRef = React.useRef(true);
  React.useEffect(() => {
    activeRef.current = routeConversationId === 'new';
    return () => {
      activeRef.current = false;
    };
  }, [routeConversationId]);

  const isCreateMode = routeConversationId === 'new';

  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
  const pendingFundingSource = usePendingChatStore((s) => s.pendingFundingSource);
  const clearPendingMessage = usePendingChatStore((s) => s.clearPendingMessage);

  const [realConversationId, setRealConversationId] = React.useState<string | null>(
    isCreateMode ? null : routeConversationId
  );
  const [localMessages, setLocalMessages] = React.useState<Message[]>([]);
  const [localTitle, setLocalTitle] = React.useState<string | null>(null);

  const {
    optimisticMessages,
    addOptimisticMessage,
    removeOptimisticMessage,
    updateOptimisticMessageContent,
    resetOptimisticMessages,
  } = useOptimisticMessages();

  const { selectedModels } = useModelStore();
  const { webSearchEnabled } = useSearchStore();
  const { isStreaming, startStream, startRegenerateStream } = useChatStream('authenticated');
  const chatError = useChatErrorStore((s) => s.error);
  const createConversation = useCreateConversation();
  const createConversationRef = React.useRef(createConversation.mutateAsync);
  React.useEffect(() => {
    createConversationRef.current = createConversation.mutateAsync;
  });
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const authUserId = useAuthStore((s) => s.user?.id);
  const customInstructions = useAuthStore((s) => s.customInstructions);

  const queryId = resolveQueryId(realConversationId);
  const conversationQuery = useConversation(queryId);
  const conversation = conversationQuery.data;
  const isConversationLoading = conversationQuery.isLoading;

  const callerId = resolveCallerId(conversation?.callerId, authUserId);
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(queryId);
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

  React.useEffect(() => {
    if (isCreateMode || routeConversationId === realConversationId) return;
    setRealConversationId(routeConversationId);
    resetOptimisticMessages();
    setLocalMessages([]);
    setLocalTitle(null);
    useChatErrorStore.getState().clearError();
  }, [isCreateMode, routeConversationId, realConversationId, resetOptimisticMessages]);

  React.useEffect(() => {
    return () => {
      useChatErrorStore.getState().clearError();
    };
  }, []);

  const modelMessageMapRef = React.useRef(new Map<string, string>());

  const handleStreamStart = React.useCallback(
    (data: StartEventData) => {
      const { modelMap, messages, assistantMessageIds } = processStartEvent(
        data,
        conversationIdRef.current,
        data.userMessageId
      );
      modelMessageMapRef.current = modelMap;
      setLocalMessages((previous) => [...previous, ...messages]);
      startStreamingIfNeeded(assistantMessageIds, state);
    },
    [state]
  );

  const handleStreamToken = React.useCallback((token: string, modelId: string) => {
    const msgId = modelMessageMapRef.current.get(modelId);
    if (msgId) {
      setLocalMessages((previous) => appendTokenToMessage(previous, msgId, token));
    }
  }, []);

  const optimisticModelMapRef = React.useRef(new Map<string, string>());

  const createOptimisticStreamCallbacks = React.useCallback(
    (convId: string) => ({
      onStart: (data: StartEventData) => {
        const { modelMap, messages, assistantMessageIds } = processStartEvent(
          data,
          convId,
          data.userMessageId
        );
        optimisticModelMapRef.current = modelMap;
        for (const msg of messages) {
          addOptimisticMessage(msg);
        }
        startStreamingIfNeeded(assistantMessageIds, state);
      },
      onToken: (token: string, modelId: string) => {
        const msgId = optimisticModelMapRef.current.get(modelId);
        if (msgId) {
          updateOptimisticMessageContent(msgId, token);
        }
      },
    }),
    [state, addOptimisticMessage, updateOptimisticMessageContent]
  );

  interface ExecuteStreamParams {
    convId: string;
    userMessageData: { id: string; content: string };
    messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
    fundingSource: FundingSource;
    forkId?: string;
  }

  const executeStream = React.useCallback(
    async (params: ExecuteStreamParams): Promise<{ models: ModelResult[] }> => {
      const { convId, userMessageData, messagesForInference, fundingSource, forkId } = params;
      const callbacks = createOptimisticStreamCallbacks(convId);
      const { models } = await startStream(
        {
          conversationId: convId,
          models: selectedModels.map((m) => m.id),
          userMessage: userMessageData,
          messagesForInference,
          fundingSource,
          webSearchEnabled,
          ...(customInstructions != null && { customInstructions }),
          ...(forkId != null && { forkId }),
        },
        callbacks
      );
      state.stopStreaming();
      // When sending in a fork, invalidate the broader conversation key so the forks query
      // (which includes tipMessageId) is also refetched. Otherwise the stale tip causes
      // the new messages to be filtered out by fork filtering.
      const invalidationKey = forkId ? chatKeys.conversation(convId) : chatKeys.messages(convId);
      await queryClient.invalidateQueries({ queryKey: invalidationKey });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

      return { models };
    },
    [
      createOptimisticStreamCallbacks,
      startStream,
      selectedModels,
      webSearchEnabled,
      customInstructions,
      state,
      queryClient,
    ]
  );

  React.useEffect(() => {
    if (!isCreateMode || !pendingMessage || creationStartedRef.current || !accountPrivateKey) {
      return;
    }
    creationStartedRef.current = true;

    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;

    const userMessage = createUserMessage(conversationId, pendingMessage, callerId, null);
    setLocalMessages([userMessage]);

    const createConversationAndStream = async (): Promise<void> => {
      try {
        const accountPublicKey = getPublicKeyFromPrivate(accountPrivateKey);
        const epoch = createFirstEpoch([accountPublicKey]);
        const ownerWrap = epoch.memberWraps[0];
        if (!ownerWrap) throw new Error('createFirstEpoch returned no member wraps');

        const titleText = generateChatTitle(pendingMessage);
        const encryptedTitleBytes = encryptMessageForStorage(epoch.epochPublicKey, titleText);

        const response = await createConversationRef.current({
          id: conversationId,
          title: toBase64(encryptedTitleBytes),
          epochPublicKey: toBase64(epoch.epochPublicKey),
          confirmationHash: toBase64(epoch.confirmationHash),
          memberWrap: toBase64(ownerWrap.wrap),
        });

        const realId = response.conversation.id;

        if (!response.isNew) {
          queryClient.setQueryData(chatKeys.conversation(realId), response.conversation);
          clearPendingMessage();
          setRealConversationId(realId);
          navigateIfActive(activeRef, navigate, ROUTES.CHAT_ID, { id: realId });
          return;
        }

        setEpochKey(realId, 1, epoch.epochPrivateKey);

        const realUserMessage = createUserMessage(realId, pendingMessage, callerId, null);
        setLocalMessages([realUserMessage]);
        setLocalTitle(titleText);
        clearPendingMessage();
        setRealConversationId(realId);

        await executeStreamAndFinalize(
          realId,
          pendingMessage,
          response.conversation,
          pendingFundingSource ?? 'personal_balance'
        );
      } catch {
        navigateIfActive(activeRef, navigate, ROUTES.CHAT);
      }
    };

    const executeStreamAndFinalize = async (
      realId: string,
      message: string,
      conversation: { id: string },
      fundingSource: FundingSource
    ): Promise<void> => {
      const userMsgId = crypto.randomUUID();
      try {
        const streamResult = await startStream(
          {
            conversationId: realId,
            models: selectedModels.map((m) => m.id),
            userMessage: { id: userMsgId, content: message },
            messagesForInference: [{ role: 'user', content: message }],
            fundingSource,
            webSearchEnabled,
            ...(customInstructions != null && { customInstructions }),
          },
          { onStart: handleStreamStart, onToken: handleStreamToken }
        );

        attachCostsToMessages(streamResult.models, setLocalMessages);

        queryClient.setQueryData(chatKeys.conversation(realId), conversation);
        await queryClient.invalidateQueries({ queryKey: chatKeys.messages(realId) });
        void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

        state.stopStreaming();
      } catch (streamError: unknown) {
        console.error('Stream failed:', streamError);
        state.stopStreaming();
        useChatErrorStore.getState().setError(
          createChatError({
            content: friendlyErrorMessage(ERROR_CODE_CHAT_STREAM_FAILED),
            retryable: false,
            failedContent: message,
          })
        );
      }
      navigateIfActive(activeRef, navigate, ROUTES.CHAT_ID, { id: realId });
    };

    void createConversationAndStream();
  }, [
    isCreateMode,
    pendingMessage,
    pendingFundingSource,
    accountPrivateKey,
    clearPendingMessage,
    handleStreamStart,
    handleStreamToken,
    selectedModels,
    webSearchEnabled,
    customInstructions,
    startStream,
    queryClient,
    navigate,
    state,
  ]);

  /** Validate input, clear it, refocus, and return trimmed content + conversationId (or null). */
  const prepareMessageInput = React.useCallback((): {
    content: string;
    convId: string;
  } | null => {
    const content = state.inputValue.trim();
    if (!content || !realConversationId) {
      return null;
    }

    useChatErrorStore.getState().clearError();

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    return { content, convId: realConversationId };
  }, [state, realConversationId, isMobile, promptInputRef]);

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      const prepared = prepareMessageInput();
      if (!prepared) {
        return;
      }
      const { content, convId } = prepared;

      const userMessageId = crypto.randomUUID();

      // Resolve parent: last message in the current view (fork-filtered + optimistic)
      const allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages];
      const lastMessage = allCurrentMessages.at(-1);
      const optimisticUserMessage = createUserMessage(
        convId,
        content,
        callerId,
        lastMessage?.id ?? null
      );
      addOptimisticMessage(optimisticUserMessage);

      // Build messagesForInference from fork-filtered decrypted messages + new user message
      const messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
        ...forkFilteredDecrypted.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...optimisticMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user' as const, content },
      ];

      void (async () => {
        try {
          const { models: modelResults } = await executeStream({
            convId,
            userMessageData: {
              id: userMessageId,
              content,
            },
            messagesForInference,
            fundingSource,
            ...(activeForkId != null && { forkId: activeForkId }),
          });
          removeOptimisticMessage(optimisticUserMessage.id);
          for (const mr of modelResults) {
            removeOptimisticMessage(mr.assistantMessageId);
          }
        } catch (error: unknown) {
          if (error instanceof BillingMismatchError) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleRegenerationError(error, content, promptInputRef);

          removeOptimisticMessage(optimisticUserMessage.id);
          state.stopStreaming();
        }
      })();
    },
    [
      prepareMessageInput,
      addOptimisticMessage,
      removeOptimisticMessage,
      executeStream,
      forkFilteredDecrypted,
      optimisticMessages,
      activeForkId,
      state,
      realConversationId,
      promptInputRef,
    ]
  );

  const handleSendUserOnly = React.useCallback(() => {
    const prepared = prepareMessageInput();
    if (!prepared) {
      return;
    }
    const { content, convId } = prepared;

    const messageId = crypto.randomUUID();
    const allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages];
    const lastMsg = allCurrentMessages.at(-1);
    const optimisticUserMessage = createUserMessage(convId, content, callerId, lastMsg?.id ?? null);
    addOptimisticMessage(optimisticUserMessage);

    void (async () => {
      try {
        await fetchJson(
          client.api.chat[':conversationId'].message.$post({
            param: { conversationId: convId },
            json: {
              messageId,
              content,
            },
          })
        );
        removeOptimisticMessage(optimisticUserMessage.id);
        await queryClient.invalidateQueries({ queryKey: chatKeys.messages(convId) });
      } catch (error: unknown) {
        console.error('User-only message failed:', error);
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
    state,
    realConversationId,
  ]);

  const handleRegenerate = React.useCallback(
    (targetMessageId: string, action: RegenerateAction, editedContent?: string) => {
      if (!realConversationId) return;

      useChatErrorStore.getState().clearError();

      // Build messagesForInference from fork-filtered decrypted messages up to the target
      const allMsgs = [...forkFilteredDecrypted, ...optimisticMessages];

      const messagesForInference = buildMessagesForRegeneration(
        allMsgs,
        targetMessageId,
        action,
        editedContent
      );

      const userMessageId = crypto.randomUUID();
      const userContent = resolveUserContent(action, editedContent, allMsgs, targetMessageId);

      if (action === 'retry') {
        pruneMessagesAfterTarget(allMsgs, targetMessageId, setLocalMessages);

        // Optimistically update the query cache so forkFilteredDecrypted (which drives
        // the displayed message list for existing conversations) reflects the pruning
        // immediately, before streaming starts. On error, invalidateQueries restores state.
        const targetIndex = allMsgs.findIndex((m) => m.id === targetMessageId);
        if (targetIndex !== -1) {
          const idsToRemove = new Set(allMsgs.slice(targetIndex + 1).map((m) => m.id));
          queryClient.setQueryData(
            chatKeys.messages(realConversationId),
            (old: MessageResponse[] | undefined) =>
              old ? old.filter((m) => !idsToRemove.has(m.id)) : old
          );
        }
      }

      const request: RegenerateStreamRequest = {
        conversationId: realConversationId,
        targetMessageId,
        action,
        model: getPrimaryModel(selectedModels).id,
        userMessage: { id: userMessageId, content: userContent },
        messagesForInference,
        fundingSource: 'personal_balance',
        ...(activeForkId != null && { forkId: activeForkId }),
        ...(webSearchEnabled && { webSearchEnabled }),
        ...(customInstructions != null && { customInstructions }),
      };

      const assistantMsgId = crypto.randomUUID();
      const assistantMsg = createAssistantMessage(
        realConversationId,
        assistantMsgId,
        getPrimaryModel(selectedModels).id,
        targetMessageId
      );
      addOptimisticMessage(assistantMsg);
      state.startStreaming([assistantMsgId]);

      void (async () => {
        try {
          const streamResult = await startRegenerateStream(request, {
            onStart: () => {
              updateOptimisticMessageContent(assistantMsgId, '');
            },
            onToken: (token) => {
              updateOptimisticMessageContent(assistantMsgId, token);
            },
          });

          state.stopStreaming();
          removeOptimisticMessage(assistantMsgId);
          attachCostsToMessages(streamResult.models, setLocalMessages);

          await queryClient.invalidateQueries({
            queryKey: chatKeys.messages(realConversationId),
          });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        } catch (error: unknown) {
          state.stopStreaming();
          removeOptimisticMessage(assistantMsgId);

          if (error instanceof BillingMismatchError) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleRegenerationError(error, userContent, promptInputRef);

          await queryClient.invalidateQueries({
            queryKey: chatKeys.messages(realConversationId),
          });
        }
      })();
    },
    [
      realConversationId,
      activeForkId,
      forkFilteredDecrypted,
      optimisticMessages,
      selectedModels,
      webSearchEnabled,
      customInstructions,
      startRegenerateStream,
      addOptimisticMessage,
      removeOptimisticMessage,
      updateOptimisticMessageContent,
      state,
      queryClient,
    ]
  );

  const allMessages = React.useMemo(
    () =>
      mergeMessages({
        isCreateMode,
        realConversationId,
        localMessages,
        decryptedApiMessages: forkFilteredDecrypted,
        optimisticMessages,
        chatError,
      }),
    [
      isCreateMode,
      realConversationId,
      localMessages,
      forkFilteredDecrypted,
      optimisticMessages,
      chatError,
    ]
  );

  const historyCharacters = React.useMemo(() => {
    return allMessages.reduce((total, message) => total + message.content.length, 0);
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

  // Subscribe to epoch key cache for title decryption reactivity
  const epochCacheVersion = React.useSyncExternalStore(epochCacheSubscribe, epochCacheSnapshot);

  // Decrypt conversation title from API (base64 ECIES blob) using cached epoch key
  const displayTitle = React.useMemo(
    () => computeDisplayTitle(localTitle, conversation, realConversationId),
    [conversation, realConversationId, localTitle, epochCacheVersion]
  );
  const callerPrivilege = conversation?.callerPrivilege as MemberPrivilege | undefined;
  const inputDisabled = computeInputDisabled(isCreateMode, realConversationId, callerPrivilege);

  const errorMessageId: string | undefined = chatError?.id;

  return {
    state,
    renderState,
    messages: allMessages,
    historyCharacters,
    displayTitle,
    inputDisabled,
    isStreaming,
    handleSend,
    handleSendUserOnly,
    handleRegenerate,
    promptInputRef,
    errorMessageId,
    realConversationId,
    callerId,
    callerPrivilege,
  };
}

export { DECRYPTING_TITLE } from '@/hooks/chat';
