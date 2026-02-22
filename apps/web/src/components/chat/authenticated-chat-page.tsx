import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ChatLayout } from '@/components/chat/chat-layout';
import { useAuthenticatedChat } from '@/hooks/use-authenticated-chat';
import { useGroupChat } from '@/hooks/use-group-chat';
import { ROUTES } from '@hushbox/shared';
import type { Message } from '@/lib/api';

interface AuthenticatedChatPageProps {
  readonly routeConversationId: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for disabled submit handler
const NOOP = (): void => {};

export function AuthenticatedChatPage({
  routeConversationId,
}: AuthenticatedChatPageProps): React.JSX.Element {
  const chat = useAuthenticatedChat({ routeConversationId });
  const conversationId =
    routeConversationId === 'new' ? chat.realConversationId : routeConversationId;
  const groupChat = useGroupChat(conversationId, chat.displayTitle);

  // Merge remote streaming phantom messages into the messages array
  const remotePhantoms = groupChat?.remoteStreamingMessages;
  const phantomMessages = React.useMemo((): Message[] => {
    if (!remotePhantoms || remotePhantoms.size === 0) return [];
    const result: Message[] = [];
    for (const [id, phantom] of remotePhantoms) {
      result.push({
        id,
        conversationId: conversationId ?? '',
        role: phantom.senderType === 'user' ? 'user' : 'assistant',
        content: phantom.content,
        createdAt: '',
        ...(phantom.senderId !== undefined && { senderId: phantom.senderId }),
      });
    }
    return result;
  }, [remotePhantoms, conversationId]);

  const messagesWithPhantoms = React.useMemo((): Message[] => {
    if (phantomMessages.length === 0) return chat.messages;
    return [...chat.messages, ...phantomMessages];
  }, [chat.messages, phantomMessages]);

  // Determine streaming message ID — local streaming takes priority over remote
  const remoteStreamingId = React.useMemo((): string | null => {
    if (!remotePhantoms) return null;
    for (const [id, phantom] of remotePhantoms) {
      if (phantom.senderType === 'ai') return id;
    }
    return null;
  }, [remotePhantoms]);

  const effectiveStreamingId = chat.state.streamingMessageId ?? remoteStreamingId;

  if (chat.renderState.type === 'redirecting' || chat.renderState.type === 'not-found') {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (chat.renderState.type === 'loading') {
    return (
      <ChatLayout
        title={chat.renderState.title}
        messages={[]}
        streamingMessageId={null}
        inputValue=""
        onInputChange={chat.state.setInputValue}
        onSubmit={NOOP}
        inputDisabled={true}
        isProcessing={false}
        historyCharacters={0}
        isAuthenticated={true}
        isDecrypting={true}
        conversationId={conversationId ?? undefined}
        groupChat={groupChat}
      />
    );
  }

  return (
    <ChatLayout
      title={chat.displayTitle}
      messages={messagesWithPhantoms}
      streamingMessageId={effectiveStreamingId}
      inputValue={chat.state.inputValue}
      onInputChange={chat.state.setInputValue}
      onSubmit={chat.handleSend}
      onSubmitUserOnly={chat.handleSendUserOnly}
      inputDisabled={chat.inputDisabled}
      isProcessing={chat.isStreaming}
      historyCharacters={chat.historyCharacters}
      isAuthenticated={true}
      promptInputRef={chat.promptInputRef}
      errorMessageId={chat.errorMessageId}
      conversationId={conversationId ?? undefined}
      groupChat={groupChat}
    />
  );
}
