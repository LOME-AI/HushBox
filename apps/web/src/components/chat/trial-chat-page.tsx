import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { createTrialMessage } from '@/lib/chat-messages';
import { buildMessagesForRegeneration } from '@/lib/chat-regeneration';
import { useChatPageState } from '@/hooks/use-chat-page';
import { useChatStream, TrialRateLimitError } from '@/hooks/use-chat-stream';
import { useTrialChatStore } from '@/stores/trial-chat';
import { useModelStore, getPrimaryModel } from '@/stores/model';
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

  const { selectedModels } = useModelStore();
  const { isStreaming, startStream } = useChatStream('trial');

  const {
    messages: trialMessages,
    pendingMessage: trialPendingMessage,
    isRateLimited,
    addMessage: addTrialMessage,
    appendToMessage: appendToTrialMessage,
    clearPendingMessage: clearTrialPendingMessage,
    setRateLimited,
    removeMessagesAfter,
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

  const primaryModelId = getPrimaryModel(selectedModels).id;

  const executeStream = React.useCallback(
    async (apiMessages: { role: 'user' | 'assistant'; content: string }[]): Promise<void> => {
      try {
        await startStream(
          { messages: apiMessages, model: primaryModelId },
          {
            onStart: ({ models }) => {
              const assistantMessageId = models[0]?.assistantMessageId;
              if (!assistantMessageId) return;
              const assistantMessage = createTrialMessage('assistant', '', assistantMessageId);
              addTrialMessage(assistantMessage);
              state.startStreaming([assistantMessageId]);
            },
            onToken: (token) => {
              const ids = state.streamingMessageIdsRef.current;
              const msgId = ids.size > 0 ? ids.values().next().value : null;
              if (msgId) {
                appendToTrialMessage(msgId, token);
              }
            },
          }
        );

        state.stopStreaming();
      } catch (error) {
        state.stopStreaming();
        handleStreamError(error);
      }
    },
    [startStream, primaryModelId, addTrialMessage, appendToTrialMessage, state, handleStreamError]
  );

  const handleTrialFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearTrialPendingMessage();
      useChatErrorStore.getState().clearError();

      const userMessage = createTrialMessage('user', content);
      addTrialMessage(userMessage);

      await executeStream([{ role: 'user' as const, content }]);
    },
    [clearTrialPendingMessage, addTrialMessage, executeStream]
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

    const apiMessages = [...trialMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    await executeStream(apiMessages);
  }, [state, isStreaming, isRateLimited, isMobile, trialMessages, addTrialMessage, executeStream]);

  const handleTrialRegenerate = React.useCallback(
    async (targetMessageId: string): Promise<void> => {
      if (isStreaming || isRateLimited) return;

      const target = trialMessages.find((m) => m.id === targetMessageId);
      if (!target) return;

      useChatErrorStore.getState().clearError();

      const action = target.role === 'assistant' ? 'regenerate' : 'retry';
      const inferenceMessages = buildMessagesForRegeneration(
        trialMessages,
        targetMessageId,
        action
      );
      const apiMessages = inferenceMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // For regenerate, truncate before the AI message (keep the preceding user message)
      // For retry, truncate after the user message (keep the user message)
      if (action === 'regenerate') {
        const targetIndex = trialMessages.findIndex((m) => m.id === targetMessageId);
        const precedingMessage = trialMessages[targetIndex - 1];
        if (targetIndex > 0 && precedingMessage) {
          removeMessagesAfter(precedingMessage.id);
        }
      } else {
        removeMessagesAfter(targetMessageId);
      }

      await executeStream(apiMessages);
    },
    [isStreaming, isRateLimited, trialMessages, removeMessagesAfter, executeStream]
  );

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
      streamingMessageIds={state.streamingMessageIds}
      inputValue={state.inputValue}
      onInputChange={state.setInputValue}
      onSubmit={() => void handleTrialSubmit()}
      inputDisabled={isRateLimited}
      isProcessing={isStreaming}
      historyCharacters={historyCharacters}
      isAuthenticated={false}
      promptInputRef={promptInputRef}
      errorMessageId={chatError?.id}
      onRegenerate={(messageId: string) => void handleTrialRegenerate(messageId)}
    />
  );
}
