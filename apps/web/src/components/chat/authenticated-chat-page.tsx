import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import { useAuthenticatedChat } from '@/hooks/use-authenticated-chat';
import { ROUTES } from '@/lib/routes';

interface AuthenticatedChatPageProps {
  readonly routeConversationId: string;
  readonly triggerStreaming?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for disabled submit handler
const NOOP = (): void => {};

export function AuthenticatedChatPage({
  routeConversationId,
  triggerStreaming,
}: AuthenticatedChatPageProps): React.JSX.Element {
  const chat = useAuthenticatedChat({ routeConversationId, triggerStreaming });

  if (chat.renderState.type === 'redirecting' || chat.renderState.type === 'not-found') {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (chat.renderState.type === 'loading') {
    return (
      <ChatLayout
        title={chat.renderState.title}
        messages={[]}
        streamingMessageId={null}
        onDocumentsExtracted={chat.state.handleDocumentsExtracted}
        inputValue=""
        onInputChange={chat.state.setInputValue}
        onSubmit={NOOP}
        inputDisabled={true}
        isProcessing={false}
        historyCharacters={0}
        documents={[]}
        isAuthenticated={true}
      />
    );
  }

  return (
    <ChatLayout
      title={chat.displayTitle}
      messages={chat.messages}
      streamingMessageId={chat.state.streamingMessageId}
      onDocumentsExtracted={chat.state.handleDocumentsExtracted}
      inputValue={chat.state.inputValue}
      onInputChange={chat.state.setInputValue}
      onSubmit={chat.handleSend}
      inputDisabled={chat.inputDisabled}
      isProcessing={chat.isStreaming}
      historyCharacters={chat.historyCharacters}
      documents={chat.state.allDocuments}
      isAuthenticated={true}
      promptInputRef={chat.promptInputRef}
    />
  );
}
