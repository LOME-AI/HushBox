import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { MessageInput } from '@/components/chat/message-input';
import { EmptyChat } from '@/components/chat/empty-chat';
import { useConversation, useMessages } from '@/hooks/chat';
import { useSession } from '@/lib/auth';
import type { Message } from '@/lib/api';

export const Route = createFileRoute('/_app/chat/$conversationId')({
  component: ChatConversation,
});

function ChatConversation(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const isNewChat = conversationId === 'new';
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  // Fetch real data for existing conversations
  const { data: conversation } = useConversation(isNewChat ? '' : conversationId);
  const { data: apiMessages, isLoading } = useMessages(isNewChat ? '' : conversationId);

  // Local messages for new chat (before API create)
  const [localMessages, setLocalMessages] = React.useState<Message[]>([]);

  // Combine API messages with local messages
  const allMessages = React.useMemo(() => {
    if (isNewChat) {
      return localMessages;
    }
    return [...(apiMessages ?? []), ...localMessages];
  }, [apiMessages, localMessages, isNewChat]);

  const handleSend = (content: string): void => {
    const newMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: isNewChat ? 'pending' : conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setLocalMessages((prev) => [...prev, newMessage]);

    // Simulate assistant response (will be replaced with real streaming API)
    setTimeout(() => {
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: isNewChat ? 'pending' : conversationId,
        role: 'assistant',
        content: `This is a mock response to: "${content}"`,
        createdAt: new Date().toISOString(),
      };
      setLocalMessages((prev) => [...prev, assistantMessage]);
    }, 500);
  };

  const handleSuggestionClick = (prompt: string): void => {
    handleSend(prompt);
  };

  // Determine the chat title
  const chatTitle = isNewChat
    ? 'New Chat'
    : (conversation?.title ?? `Chat ${conversationId.slice(0, 8)}...`);

  if (isLoading && !isNewChat) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title="Loading..." />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-muted-foreground">Loading conversation...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader title={chatTitle} />
      <div className="flex flex-1 flex-col overflow-hidden">
        {allMessages.length === 0 ? (
          <EmptyChat onSuggestionClick={handleSuggestionClick} isAuthenticated={isAuthenticated} />
        ) : (
          <MessageList messages={allMessages} />
        )}
      </div>
      <div className="border-t">
        <MessageInput onSend={handleSend} />
      </div>
    </div>
  );
}
