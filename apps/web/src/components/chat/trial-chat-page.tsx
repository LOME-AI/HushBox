import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { createTrialMessage } from '@/lib/chat-messages';
import { useChatPageState } from '@/hooks/use-chat-page';
import { useChatStream, TrialRateLimitError } from '@/hooks/use-chat-stream';
import { useTrialChatStore } from '@/stores/trial-chat';
import { useModelStore } from '@/stores/model';
import { useChatErrorStore, createChatError } from '@/stores/chat-error';
import { useSession } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { Message } from '@/lib/api';
import { ROUTES, friendlyErrorMessage, customUserMessage } from '@hushbox/shared';

export function TrialChatPage(): React.JSX.Element {
  const state = useChatPageState();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);
  const [creationStarted, setCreationStarted] = React.useState(false);

  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const { selectedModelId } = useModelStore();
  const { isStreaming, startStream } = useChatStream('trial');

  const {
    messages: trialMessages,
    pendingMessage: trialPendingMessage,
    isRateLimited,
    addMessage: addTrialMessage,
    updateMessageContent: updateTrialMessageContent,
    appendToMessage: appendToTrialMessage,
    clearPendingMessage: clearTrialPendingMessage,
    setRateLimited,
  } = useTrialChatStore();

  const chatError = useChatErrorStore((s) => s.error);

  React.useEffect(() => {
    useChatErrorStore.getState().clearError();
    return () => {
      useChatErrorStore.getState().clearError();
    };
  }, []);

  const handleStreamError = React.useCallback(
    (error: unknown): void => {
      const lastUserMsg = trialMessages.findLast((m) => m.role === 'user');
      if (error instanceof TrialRateLimitError) {
        useChatErrorStore.getState().setError(
          createChatError({
            content: customUserMessage(
              `You've used all 5 free messages today. [Sign up](${ROUTES.SIGNUP}) to continue chatting!`
            ),
            retryable: false,
            failedContent: lastUserMsg?.content ?? '',
          })
        );
        setRateLimited(true);
      } else {
        console.error('Trial chat error:', error);
        useChatErrorStore.getState().setError(
          createChatError({
            content: friendlyErrorMessage('INTERNAL'),
            retryable: false,
            failedContent: lastUserMsg?.content ?? '',
          })
        );
      }
    },
    [setRateLimited, trialMessages]
  );

  const handleTrialFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearTrialPendingMessage();
      useChatErrorStore.getState().clearError();

      const userMessage = createTrialMessage('user', content);
      addTrialMessage(userMessage);

      const apiMessages = [{ role: 'user' as const, content }];

      try {
        const result = await startStream(
          { messages: apiMessages, model: selectedModelId },
          {
            onStart: ({ assistantMessageId }) => {
              const assistantMessage = createTrialMessage('assistant', '', assistantMessageId);
              addTrialMessage(assistantMessage);
              state.startStreaming(assistantMessageId);
            },
            onToken: (token) => {
              const msgId = state.streamingMessageIdRef.current;
              if (msgId) {
                appendToTrialMessage(msgId, token);
              }
            },
          }
        );

        if (result.assistantMessageId) {
          updateTrialMessageContent(result.assistantMessageId, result.content);
        }

        state.stopStreaming();
      } catch (error) {
        state.stopStreaming();
        handleStreamError(error);
      }
    },
    [
      clearTrialPendingMessage,
      addTrialMessage,
      startStream,
      selectedModelId,
      appendToTrialMessage,
      updateTrialMessageContent,
      state,
      handleStreamError,
    ]
  );

  React.useEffect(() => {
    if (trialPendingMessage && !creationStartedRef.current && !isStreaming) {
      creationStartedRef.current = true;
      setCreationStarted(true);
      void handleTrialFirstMessage(trialPendingMessage);
    }
  }, [trialPendingMessage, isStreaming, handleTrialFirstMessage]);

  const handleTrialSubmit = React.useCallback(async () => {
    const content = state.inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    useChatErrorStore.getState().clearError();
    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const userMessage = createTrialMessage('user', content);
    addTrialMessage(userMessage);

    const apiMessagesPayload = [...trialMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const result = await startStream(
        { messages: apiMessagesPayload, model: selectedModelId },
        {
          onStart: ({ assistantMessageId }) => {
            const assistantMessage = createTrialMessage('assistant', '', assistantMessageId);
            addTrialMessage(assistantMessage);
            state.startStreaming(assistantMessageId);
          },
          onToken: (token) => {
            const msgId = state.streamingMessageIdRef.current;
            if (msgId) {
              appendToTrialMessage(msgId, token);
            }
          },
        }
      );

      if (result.assistantMessageId) {
        updateTrialMessageContent(result.assistantMessageId, result.content);
      }

      state.stopStreaming();
    } catch (error) {
      state.stopStreaming();
      handleStreamError(error);
    }
  }, [
    state,
    isStreaming,
    isRateLimited,
    isMobile,
    trialMessages,
    selectedModelId,
    startStream,
    addTrialMessage,
    appendToTrialMessage,
    updateTrialMessageContent,
    handleStreamError,
  ]);

  if (!isSessionPending && isAuthenticated) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (!trialPendingMessage && trialMessages.length === 0 && !creationStarted) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  const historyCharacters = trialMessages.reduce(
    (total, message) => total + message.content.length,
    0
  );

  const displayMessages: Message[] = [...(trialMessages as Message[])];
  if (chatError) {
    displayMessages.push({
      id: chatError.id,
      conversationId: 'trial',
      role: 'assistant',
      content: chatError.content,
      createdAt: new Date().toISOString(),
    });
  }

  return (
    <ChatLayout
      messages={displayMessages}
      streamingMessageId={state.streamingMessageId}
      inputValue={state.inputValue}
      onInputChange={state.setInputValue}
      onSubmit={() => void handleTrialSubmit()}
      inputDisabled={isRateLimited}
      isProcessing={isStreaming}
      historyCharacters={historyCharacters}
      isAuthenticated={false}
      promptInputRef={promptInputRef}
      errorMessageId={chatError?.id}
    />
  );
}
