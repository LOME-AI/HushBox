import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { createGuestMessage } from '@/lib/chat-messages';
import { useChatPageState } from '@/hooks/use-chat-page';
import { useChatStream, GuestRateLimitError } from '@/hooks/use-chat-stream';
import { useGuestChatStore } from '@/stores/guest-chat';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useSession } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { Message } from '@/lib/api';
import { ROUTES } from '@/lib/routes';

export function GuestChatPage(): React.JSX.Element {
  const state = useChatPageState();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const [creationStarted, setCreationStarted] = React.useState(false);

  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const { selectedModelId } = useModelStore();
  const { isStreaming, startStream } = useChatStream('guest');

  const {
    messages: guestMessages,
    pendingMessage: guestPendingMessage,
    isRateLimited,
    addMessage: addGuestMessage,
    updateMessageContent: updateGuestMessageContent,
    appendToMessage: appendToGuestMessage,
    clearPendingMessage: clearGuestPendingMessage,
    setRateLimited,
  } = useGuestChatStore();

  const handleStreamError = React.useCallback(
    (error: unknown): void => {
      if (error instanceof GuestRateLimitError) {
        setRateLimited(true);
        useUIModalsStore.getState().openSignupModal(undefined, 'rate-limit');
      } else {
        console.error('Guest chat error:', error);
      }
    },
    [setRateLimited]
  );

  const handleGuestFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearGuestPendingMessage();

      const userMessage = createGuestMessage('user', content);
      addGuestMessage(userMessage);

      const apiMessages = [{ role: 'user' as const, content }];

      try {
        const result = await startStream(
          { messages: apiMessages, model: selectedModelId },
          {
            onStart: ({ assistantMessageId }) => {
              const assistantMessage = createGuestMessage('assistant', '', assistantMessageId);
              addGuestMessage(assistantMessage);
              state.startStreaming(assistantMessageId);
            },
            onToken: (token) => {
              const msgId = state.streamingMessageIdRef.current;
              if (msgId) {
                appendToGuestMessage(msgId, token);
              }
            },
          }
        );

        if (result.assistantMessageId) {
          updateGuestMessageContent(result.assistantMessageId, result.content);
        }

        state.stopStreaming();
      } catch (error) {
        state.stopStreaming();
        handleStreamError(error);
      }
    },
    [
      clearGuestPendingMessage,
      addGuestMessage,
      startStream,
      selectedModelId,
      appendToGuestMessage,
      updateGuestMessageContent,
      state,
      handleStreamError,
    ]
  );

  React.useEffect(() => {
    if (guestPendingMessage && !creationStarted && !isStreaming) {
      setCreationStarted(true);
      void handleGuestFirstMessage(guestPendingMessage);
    }
  }, [guestPendingMessage, creationStarted, isStreaming, handleGuestFirstMessage]);

  const handleGuestSubmit = React.useCallback(async () => {
    const content = state.inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const userMessage = createGuestMessage('user', content);
    addGuestMessage(userMessage);

    const apiMessagesPayload = [...guestMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const result = await startStream(
        { messages: apiMessagesPayload, model: selectedModelId },
        {
          onStart: ({ assistantMessageId }) => {
            const assistantMessage = createGuestMessage('assistant', '', assistantMessageId);
            addGuestMessage(assistantMessage);
            state.startStreaming(assistantMessageId);
          },
          onToken: (token) => {
            const msgId = state.streamingMessageIdRef.current;
            if (msgId) {
              appendToGuestMessage(msgId, token);
            }
          },
        }
      );

      if (result.assistantMessageId) {
        updateGuestMessageContent(result.assistantMessageId, result.content);
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
    guestMessages,
    selectedModelId,
    startStream,
    addGuestMessage,
    appendToGuestMessage,
    updateGuestMessageContent,
    handleStreamError,
  ]);

  if (!isSessionPending && isAuthenticated) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (!guestPendingMessage && guestMessages.length === 0 && !creationStarted) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  const historyCharacters = guestMessages.reduce(
    (total, message) => total + message.content.length,
    0
  );

  return (
    <ChatLayout
      messages={guestMessages as Message[]}
      streamingMessageId={state.streamingMessageId}
      onDocumentsExtracted={state.handleDocumentsExtracted}
      inputValue={state.inputValue}
      onInputChange={state.setInputValue}
      onSubmit={() => void handleGuestSubmit()}
      inputDisabled={isRateLimited}
      isProcessing={isStreaming}
      historyCharacters={historyCharacters}
      documents={state.allDocuments}
      isAuthenticated={false}
      rateLimitMessage={isRateLimited}
      promptInputRef={promptInputRef}
    />
  );
}
