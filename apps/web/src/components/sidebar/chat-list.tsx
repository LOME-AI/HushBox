import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { ChatItem } from './chat-item';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatListProps {
  conversations: Conversation[];
  activeId?: string | undefined;
}

export function ChatList({ conversations, activeId }: ChatListProps): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  if (conversations.length === 0) {
    return (
      <div className="text-sidebar-foreground/50 px-2 py-4 text-center text-sm">
        {sidebarOpen ? 'No conversations yet' : ''}
      </div>
    );
  }

  return (
    <ul role="list" aria-label="Conversations" className="flex flex-col gap-1 px-2">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <ChatItem conversation={conversation} isActive={conversation.id === activeId} />
        </li>
      ))}
    </ul>
  );
}
