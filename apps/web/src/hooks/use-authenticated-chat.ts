import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { createUserMessage, createAssistantMessage } from '@/lib/chat-messages';
import { useChatPageState } from '@/hooks/use-chat-page';
import { useChatStream } from '@/hooks/use-chat-stream';
import { useOptimisticMessages } from '@/hooks/use-optimistic-messages';
import {
  useConversation,
  useMessages,
  useSendMessage,
  useCreateConversation,
  chatKeys,
} from '@/hooks/chat';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useModelStore } from '@/stores/model';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { billingKeys } from '@/hooks/billing';
import { generateChatTitle } from '@lome-chat/shared';
import type { Message } from '@/lib/api';
import { ROUTES } from '@/lib/routes';

interface UseAuthenticatedChatInput {
  readonly routeConversationId: string;
  readonly triggerStreaming?: boolean | undefined;
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
  readonly handleSend: () => void;
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
}

interface ResponseMessage {
  readonly id?: string;
  readonly createdAt?: string;
}

interface ComputeRenderStateParams {
  isCreateMode: boolean;
  pendingMessage: string | null;
  localMessagesLength: number;
  conversation: { title: string } | undefined;
  isConversationLoading: boolean;
  isMessagesLoading: boolean;
}

interface ShouldTriggerStreamParams {
  triggerStreaming: boolean | undefined;
  realConversationId: string | null;
  isCreateMode: boolean;
  isConversationLoading: boolean;
  isMessagesLoading: boolean;
  isStreaming: boolean;
  apiMessages: Message[] | undefined;
}

function shouldTriggerStream(params: ShouldTriggerStreamParams): boolean {
  const {
    triggerStreaming,
    realConversationId,
    isCreateMode,
    isConversationLoading,
    isMessagesLoading,
    isStreaming,
    apiMessages,
  } = params;

  if (!triggerStreaming || !realConversationId || isCreateMode) {
    return false;
  }
  if (isConversationLoading || isMessagesLoading || isStreaming) {
    return false;
  }
  if (!apiMessages || apiMessages.length === 0) {
    return false;
  }

  const lastMessage = apiMessages.at(-1);
  return lastMessage?.role === 'user';
}

async function executeAndCleanupStream(
  conversationId: string,
  executeStream: (id: string) => Promise<string>,
  removeOptimisticMessage: (id: string) => void,
  stopStreaming: () => void
): Promise<void> {
  try {
    const assistantMessageId = await executeStream(conversationId);
    removeOptimisticMessage(assistantMessageId);
  } catch (error: unknown) {
    console.error('Stream failed:', error);
    stopStreaming();
  }
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
    return { type: 'loading', title: conversation?.title };
  }

  return { type: 'ready' };
}

function applyMessageIds(message: Message, responseMessage: ResponseMessage | undefined): Message {
  if (!responseMessage) {
    return message;
  }
  const updated = { ...message };
  if (responseMessage.id) {
    updated.id = responseMessage.id;
  }
  if (responseMessage.createdAt) {
    updated.createdAt = responseMessage.createdAt;
  }
  return updated;
}

function needsStreamResume(messages: Message[]): boolean {
  const hasAssistantMessage = messages.some((m) => m.role === 'assistant');
  return !hasAssistantMessage && messages.length > 0;
}

export function useAuthenticatedChat({
  routeConversationId,
  triggerStreaming,
}: UseAuthenticatedChatInput): UseAuthenticatedChatResult {
  const state = useChatPageState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);

  const isCreateMode = routeConversationId === 'new';

  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
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
  const createConversation = useCreateConversation();
  const sendMessage = useSendMessage();

  const { data: conversation, isLoading: isConversationLoading } = useConversation(
    realConversationId ?? ''
  );
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(realConversationId ?? '');

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
    }
  }, [isCreateMode, routeConversationId, realConversationId, resetOptimisticMessages]);

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

  const invalidateAfterStream = React.useCallback(
    async (convId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await queryClient.invalidateQueries({ queryKey: chatKeys.messages(convId) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
    },
    [queryClient]
  );

  const executeStream = React.useCallback(
    async (convId: string): Promise<string> => {
      const callbacks = createOptimisticStreamCallbacks(convId);
      const { assistantMessageId } = await startStream(
        { conversationId: convId, model: selectedModelId },
        callbacks
      );
      state.stopStreaming();
      await invalidateAfterStream(convId);
      return assistantMessageId;
    },
    [createOptimisticStreamCallbacks, startStream, selectedModelId, state, invalidateAfterStream]
  );

  React.useEffect(() => {
    if (!isCreateMode || !pendingMessage || creationStartedRef.current) {
      return;
    }
    creationStartedRef.current = true;

    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;

    const userMessage = createUserMessage(conversationId, pendingMessage);
    setLocalMessages([userMessage]);

    void (async () => {
      try {
        const response = await createConversation.mutateAsync({
          id: conversationId,
          firstMessage: { content: pendingMessage },
        });

        const realId = response.conversation.id;

        if (!response.isNew && response.messages) {
          setLocalMessages(response.messages);
          setLocalTitle(response.conversation.title);
          clearPendingMessage();
          setRealConversationId(realId);

          if (needsStreamResume(response.messages)) {
            try {
              const assistantMessageId = await executeStream(realId);
              removeOptimisticMessage(assistantMessageId);
            } catch (streamError: unknown) {
              console.error('Stream failed:', streamError);
              state.stopStreaming();
            }
          }

          void navigate({
            to: ROUTES.CHAT_ID,
            params: { id: realId },
            replace: true,
          });
          return;
        }

        const baseUserMessage = createUserMessage(realId, pendingMessage);
        const realUserMessage = applyMessageIds(baseUserMessage, response.message);
        setLocalMessages([realUserMessage]);
        setLocalTitle(generateChatTitle(pendingMessage));
        clearPendingMessage();

        try {
          await startStream(
            { conversationId: realId, model: selectedModelId },
            { onStart: handleStreamStart, onToken: handleStreamToken }
          );

          await new Promise((resolve) => setTimeout(resolve, 500));
          queryClient.setQueryData(chatKeys.conversation(realId), response.conversation);
          queryClient.setQueryData(chatKeys.messages(realId), localMessagesRef.current);
          void queryClient.invalidateQueries({ queryKey: chatKeys.messages(realId) });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          state.stopStreaming();
          setRealConversationId(realId);

          void navigate({
            to: ROUTES.CHAT_ID,
            params: { id: realId },
            replace: true,
          });
        } catch (streamError: unknown) {
          console.error('Stream failed:', streamError);
          state.stopStreaming();
          setRealConversationId(realId);

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
    clearPendingMessage,
    handleStreamStart,
    handleStreamToken,
    selectedModelId,
    startStream,
    queryClient,
    navigate,
    state,
    executeStream,
    removeOptimisticMessage,
  ]);

  React.useEffect(() => {
    const canTrigger = shouldTriggerStream({
      triggerStreaming,
      realConversationId,
      isCreateMode,
      isConversationLoading,
      isMessagesLoading,
      isStreaming,
      apiMessages,
    });

    if (!canTrigger || !realConversationId) {
      return;
    }

    void navigate({
      to: ROUTES.CHAT_ID,
      params: { id: realConversationId },
      search: {},
      replace: true,
    });

    void executeAndCleanupStream(
      realConversationId,
      executeStream,
      removeOptimisticMessage,
      state.stopStreaming
    );
  }, [
    triggerStreaming,
    realConversationId,
    isCreateMode,
    apiMessages,
    isConversationLoading,
    isMessagesLoading,
    isStreaming,
    executeStream,
    removeOptimisticMessage,
    navigate,
    state,
  ]);

  const handleSend = React.useCallback(() => {
    const content = state.inputValue.trim();
    if (!content || !realConversationId) {
      return;
    }

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const optimisticUserMessage = createUserMessage(realConversationId, content);
    addOptimisticMessage(optimisticUserMessage);

    sendMessage.mutate(
      {
        conversationId: realConversationId,
        message: { role: 'user', content },
      },
      {
        onSuccess: () => {
          removeOptimisticMessage(optimisticUserMessage.id);
          void (async () => {
            try {
              const assistantMessageId = await executeStream(realConversationId);
              removeOptimisticMessage(assistantMessageId);
            } catch (error: unknown) {
              console.error('Stream failed:', error);
              state.stopStreaming();
            }
          })();
        },
        onError: () => {
          removeOptimisticMessage(optimisticUserMessage.id);
          promptInputRef.current?.focus();
        },
      }
    );
  }, [
    state,
    realConversationId,
    isMobile,
    promptInputRef,
    sendMessage,
    addOptimisticMessage,
    removeOptimisticMessage,
    executeStream,
  ]);

  const allMessages = React.useMemo(() => {
    if (isCreateMode || !realConversationId) {
      return localMessages;
    }
    const messages = apiMessages ?? [];
    const apiMessageIds = new Set(messages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    return [...messages, ...pendingOptimistic];
  }, [isCreateMode, realConversationId, localMessages, apiMessages, optimisticMessages]);

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

  const displayTitle = conversation?.title ?? localTitle ?? undefined;
  const inputDisabled = isCreateMode && !realConversationId;

  return {
    state,
    renderState,
    messages: allMessages,
    historyCharacters,
    displayTitle,
    inputDisabled,
    isStreaming,
    handleSend,
    promptInputRef,
  };
}
