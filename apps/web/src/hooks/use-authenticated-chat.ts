import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { createUserMessage, createAssistantMessage } from '@/lib/chat-messages';
import { useChatPageState } from '@/hooks/use-chat-page';
import {
  useChatStream,
  BalanceReservedError,
  BillingMismatchError,
  ContextCapacityError,
} from '@/hooks/use-chat-stream';
import { useOptimisticMessages } from '@/hooks/use-optimistic-messages';
import {
  useConversation,
  useMessages,
  useCreateConversation,
  chatKeys,
  DECRYPTING_TITLE,
} from '@/hooks/chat';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useModelStore } from '@/stores/model';
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
  ROUTES,
  type FundingSource,
} from '@hushbox/shared';
import type { Message } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { useDecryptedMessages } from '@/hooks/use-decrypted-messages';
import { client, fetchJson } from '@/lib/api-client';

interface UseAuthenticatedChatInput {
  readonly routeConversationId: string;
}

type RenderState =
  | { readonly type: 'redirecting' }
  | { readonly type: 'not-found' }
  | { readonly type: 'loading'; readonly title?: string | undefined }
  | { readonly type: 'ready' };

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
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly errorMessageId: string | undefined;
  readonly realConversationId: string | null;
}

interface ComputeRenderStateParams {
  isCreateMode: boolean;
  pendingMessage: string | null;
  localMessagesLength: number;
  conversation: { title: string } | undefined;
  isConversationLoading: boolean;
  isMessagesLoading: boolean;
}

function shouldRedirect(
  isCreateMode: boolean,
  pendingMessage: string | null,
  localMessagesLength: number
): boolean {
  return isCreateMode && !pendingMessage && localMessagesLength === 0;
}

function computeRenderState(params: ComputeRenderStateParams): RenderState {
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

  return { type: 'ready' };
}

function attachCostToMessage(
  setter: React.Dispatch<React.SetStateAction<Message[]>>,
  messageId: string,
  cost: string
): void {
  setter((previous) => previous.map((m) => (m.id === messageId ? { ...m, cost } : m)));
}

export function useAuthenticatedChat({
  routeConversationId,
}: UseAuthenticatedChatInput): UseAuthenticatedChatResult {
  const state = useChatPageState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);

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

  const { selectedModelId } = useModelStore();
  const { isStreaming, startStream } = useChatStream('authenticated');
  const chatError = useChatErrorStore((s) => s.error);
  const createConversation = useCreateConversation();
  const createConversationRef = React.useRef(createConversation.mutateAsync);
  React.useEffect(() => {
    createConversationRef.current = createConversation.mutateAsync;
  });
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const userId = useAuthStore((s) => s.user?.id);

  const { data: conversation, isLoading: isConversationLoading } = useConversation(
    realConversationId ?? ''
  );
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(realConversationId ?? '');
  const decryptedApiMessages = useDecryptedMessages(realConversationId, apiMessages);

  const localMessagesRef = React.useRef<Message[]>([]);
  React.useEffect(() => {
    localMessagesRef.current = localMessages;
  }, [localMessages]);

  const conversationIdRef = React.useRef<string>('');

  React.useEffect(() => {
    if (!isCreateMode && routeConversationId !== realConversationId) {
      setRealConversationId(routeConversationId);
      resetOptimisticMessages();
      setLocalMessages([]);
      setLocalTitle(null);
      useChatErrorStore.getState().clearError();
    }
  }, [isCreateMode, routeConversationId, realConversationId, resetOptimisticMessages]);

  React.useEffect(() => {
    return () => {
      useChatErrorStore.getState().clearError();
    };
  }, []);

  const handleStreamStart = React.useCallback(
    ({ assistantMessageId }: { assistantMessageId: string }) => {
      const conversationId = conversationIdRef.current;
      const assistantMessage = createAssistantMessage(conversationId, assistantMessageId);
      setLocalMessages((previous) => [...previous, assistantMessage]);
      state.startStreaming(assistantMessageId);
    },
    [state]
  );

  const handleStreamToken = React.useCallback(
    (token: string) => {
      const msgId = state.streamingMessageIdRef.current;
      if (msgId) {
        setLocalMessages((previous) =>
          previous.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
        );
      }
    },
    [state.streamingMessageIdRef]
  );

  const createOptimisticStreamCallbacks = React.useCallback(
    (convId: string) => ({
      onStart: ({ assistantMessageId: msgId }: { assistantMessageId: string }) => {
        const assistantMessage = createAssistantMessage(convId, msgId);
        addOptimisticMessage(assistantMessage);
        state.startStreaming(msgId);
      },
      onToken: (token: string) => {
        const msgId = state.streamingMessageIdRef.current;
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
  }

  const executeStream = React.useCallback(
    async (params: ExecuteStreamParams): Promise<{ assistantMessageId: string; cost: string }> => {
      const { convId, userMessageData, messagesForInference, fundingSource } = params;
      const callbacks = createOptimisticStreamCallbacks(convId);
      const { assistantMessageId, cost } = await startStream(
        {
          conversationId: convId,
          model: selectedModelId,
          userMessage: userMessageData,
          messagesForInference,
          fundingSource,
        },
        callbacks
      );
      state.stopStreaming();
      await queryClient.invalidateQueries({ queryKey: chatKeys.messages(convId) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

      return { assistantMessageId, cost };
    },
    [createOptimisticStreamCallbacks, startStream, selectedModelId, state, queryClient]
  );

  React.useEffect(() => {
    if (!isCreateMode || !pendingMessage || creationStartedRef.current || !accountPrivateKey) {
      return;
    }
    creationStartedRef.current = true;

    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;

    const userMessage = createUserMessage(conversationId, pendingMessage, userId);
    setLocalMessages([userMessage]);

    void (async () => {
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
          void navigate({
            to: ROUTES.CHAT_ID,
            params: { id: realId },
            replace: true,
          });
          return;
        }

        // Cache the epoch private key so sidebar can decrypt the title
        setEpochKey(realId, 1, epoch.epochPrivateKey);

        const realUserMessage = createUserMessage(realId, pendingMessage, userId);
        setLocalMessages([realUserMessage]);
        setLocalTitle(titleText);
        clearPendingMessage();
        setRealConversationId(realId);

        const userMsgId = crypto.randomUUID();

        try {
          const streamResult = await startStream(
            {
              conversationId: realId,
              model: selectedModelId,
              userMessage: {
                id: userMsgId,
                content: pendingMessage,
              },
              messagesForInference: [{ role: 'user', content: pendingMessage }],
              fundingSource: pendingFundingSource ?? 'personal_balance',
            },
            { onStart: handleStreamStart, onToken: handleStreamToken }
          );

          // Attach cost to the local assistant message so it displays immediately
          const streamingMsgId = state.streamingMessageIdRef.current;
          if (streamingMsgId && streamResult.cost) {
            attachCostToMessage(setLocalMessages, streamingMsgId, streamResult.cost);
          }

          queryClient.setQueryData(chatKeys.conversation(realId), response.conversation);
          await queryClient.invalidateQueries({ queryKey: chatKeys.messages(realId) });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          state.stopStreaming();

          void navigate({
            to: ROUTES.CHAT_ID,
            params: { id: realId },
            replace: true,
          });
        } catch (streamError: unknown) {
          console.error('Stream failed:', streamError);
          state.stopStreaming();
          useChatErrorStore.getState().setError(
            createChatError({
              content: friendlyErrorMessage('CHAT_STREAM_FAILED'),
              retryable: false,
              failedContent: pendingMessage,
            })
          );

          void navigate({
            to: ROUTES.CHAT_ID,
            params: { id: realId },
            replace: true,
          });
        }
      } catch {
        void navigate({ to: ROUTES.CHAT });
      }
    })();
  }, [
    isCreateMode,
    pendingMessage,
    pendingFundingSource,
    accountPrivateKey,
    clearPendingMessage,
    handleStreamStart,
    handleStreamToken,
    selectedModelId,
    startStream,
    queryClient,
    navigate,
    state,
  ]);

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      const content = state.inputValue.trim();
      if (!content || !realConversationId) {
        return;
      }

      useChatErrorStore.getState().clearError();

      state.clearInput();
      if (!isMobile) {
        promptInputRef.current?.focus();
      }

      const userMessageId = crypto.randomUUID();

      const optimisticUserMessage = createUserMessage(realConversationId, content, userId);
      addOptimisticMessage(optimisticUserMessage);

      // Build messagesForInference from decrypted messages + new user message
      const messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
        ...decryptedApiMessages.map((m) => ({
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
          const { assistantMessageId } = await executeStream({
            convId: realConversationId,
            userMessageData: {
              id: userMessageId,
              content,
            },
            messagesForInference,
            fundingSource,
          });
          removeOptimisticMessage(optimisticUserMessage.id);
          removeOptimisticMessage(assistantMessageId);
        } catch (error: unknown) {
          if (error instanceof BillingMismatchError) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
            useChatErrorStore.getState().setError(
              createChatError({
                content: friendlyErrorMessage(error.code),
                retryable: true,
                failedContent: content,
              })
            );
          } else if (error instanceof ContextCapacityError) {
            useChatErrorStore.getState().setError(
              createChatError({
                content: friendlyErrorMessage(error.code),
                retryable: false,
                failedContent: content,
              })
            );
          } else if (error instanceof BalanceReservedError) {
            useChatErrorStore.getState().setError(
              createChatError({
                content: friendlyErrorMessage(error.code),
                retryable: true,
                failedContent: content,
              })
            );
          } else {
            console.error('Stream failed:', error);
            useChatErrorStore.getState().setError(
              createChatError({
                content: friendlyErrorMessage('CHAT_STREAM_FAILED'),
                retryable: false,
                failedContent: content,
              })
            );
            promptInputRef.current?.focus();
          }

          removeOptimisticMessage(optimisticUserMessage.id);
          state.stopStreaming();
        }
      })();
    },
    [
      state,
      realConversationId,
      isMobile,
      promptInputRef,
      addOptimisticMessage,
      removeOptimisticMessage,
      executeStream,
      decryptedApiMessages,
      optimisticMessages,
    ]
  );

  const handleSendUserOnly = React.useCallback(() => {
    const content = state.inputValue.trim();
    if (!content || !realConversationId) {
      return;
    }

    useChatErrorStore.getState().clearError();

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const messageId = crypto.randomUUID();
    const optimisticUserMessage = createUserMessage(realConversationId, content, userId);
    addOptimisticMessage(optimisticUserMessage);

    void (async () => {
      try {
        await fetchJson(
          client.api.chat.message.$post({
            json: {
              conversationId: realConversationId,
              messageId,
              content,
            },
          })
        );
        removeOptimisticMessage(optimisticUserMessage.id);
        await queryClient.invalidateQueries({ queryKey: chatKeys.messages(realConversationId) });
      } catch (error: unknown) {
        console.error('User-only message failed:', error);
        removeOptimisticMessage(optimisticUserMessage.id);
        promptInputRef.current?.focus();
      }
    })();
  }, [
    state,
    realConversationId,
    isMobile,
    promptInputRef,
    addOptimisticMessage,
    removeOptimisticMessage,
    queryClient,
  ]);

  const allMessages = React.useMemo(() => {
    let messages: Message[];
    if (isCreateMode || !realConversationId) {
      messages = localMessages;
    } else {
      const apiMessageIds = new Set(decryptedApiMessages.map((m) => m.id));
      const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
      messages = [...decryptedApiMessages, ...pendingOptimistic];
      // During create→existing transition, API messages haven't loaded yet.
      // Fall back to local messages to avoid a flash of empty content.
      if (messages.length === 0 && localMessages.length > 0) {
        messages = localMessages;
      }
    }
    if (chatError) {
      messages = [
        ...messages,
        {
          id: chatError.id,
          conversationId: realConversationId ?? '',
          role: 'assistant',
          content: chatError.content,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    return messages;
  }, [
    isCreateMode,
    realConversationId,
    localMessages,
    decryptedApiMessages,
    optimisticMessages,
    chatError,
  ]);

  const historyCharacters = React.useMemo(() => {
    return allMessages.reduce((total, message) => total + message.content.length, 0);
  }, [allMessages]);

  const renderState = React.useMemo(
    () =>
      computeRenderState({
        isCreateMode,
        pendingMessage,
        localMessagesLength: localMessages.length,
        conversation,
        isConversationLoading,
        isMessagesLoading,
      }),
    [
      isCreateMode,
      pendingMessage,
      localMessages.length,
      conversation,
      isConversationLoading,
      isMessagesLoading,
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
  const displayTitle = React.useMemo(() => {
    // Local title (from just-created conversation) takes priority
    if (localTitle) return localTitle;
    if (!conversation?.title || !realConversationId) return;
    const epochKey = getEpochKey(realConversationId, conversation.titleEpochNumber);
    if (!epochKey) return DECRYPTING_TITLE;
    try {
      return decryptMessage(epochKey, fromBase64(conversation.title));
    } catch {
      return 'Encrypted conversation';
    }
  }, [conversation, realConversationId, localTitle, epochCacheVersion]);
  const inputDisabled = isCreateMode && !realConversationId;

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
    promptInputRef,
    errorMessageId,
    realConversationId,
  };
}
