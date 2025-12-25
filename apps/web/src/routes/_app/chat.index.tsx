import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { NewChatPage } from '@/components/chat/new-chat-page';
import { useSession } from '@/lib/auth';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndex,
});

function ChatIndex(): React.JSX.Element {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  const handleSend = (content: string): void => {
    // Navigate to a new conversation with the initial prompt
    // In the future, this will create a conversation via API first
    void navigate({
      to: '/chat/$conversationId',
      params: { conversationId: 'new' },
      search: { prompt: content },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <NewChatPage onSend={handleSend} isAuthenticated={isAuthenticated} />
    </div>
  );
}
