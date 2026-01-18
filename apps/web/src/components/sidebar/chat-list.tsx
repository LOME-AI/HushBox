import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useUIStore } from '@/stores/ui';
import { ChatItem } from './chat-item';
import { ROUTES } from '@/lib/routes';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatListProps {
  conversations: Conversation[];
  activeId?: string | undefined;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean | undefined;
}

export function ChatList({
  conversations,
  activeId,
  isAuthenticated = true,
}: ChatListProps): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  if (conversations.length === 0) {
    if (!isAuthenticated) {
      return (
        <div className="text-sidebar-foreground/50 overflow-hidden px-2 py-4 text-center text-sm whitespace-nowrap">
          {sidebarOpen ? (
            <>
              <Link to={ROUTES.SIGNUP} className="text-primary hover:underline">
                Sign up
              </Link>
              {' to save conversations'}
            </>
          ) : (
            ''
          )}
        </div>
      );
    }
    return (
      <div className="text-sidebar-foreground/50 overflow-hidden px-2 py-4 text-center text-sm whitespace-nowrap">
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
