import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { ChatItem } from './chat-item';
import { ROUTES } from '@hushbox/shared';

interface Conversation {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  privilege: string;
  muted: boolean;
  pinned: boolean;
}

export interface ChatListProps {
  conversations: Conversation[];
  activeId?: string | undefined;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
  /** Accessible label for the list element */
  label?: string | undefined;
}

export function ChatList({
  conversations,
  activeId,
  isAuthenticated = true,
  onLoadMore,
  hasMore,
  isLoadingMore,
  label = 'Conversations',
}: Readonly<ChatListProps>): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const sentinelRef = React.useRef<HTMLLIElement>(null);

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasMore, onLoadMore, isLoadingMore]);

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
    <ul role="list" aria-label={label} className="flex flex-col gap-1 px-2">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <ChatItem conversation={conversation} isActive={conversation.id === activeId} />
        </li>
      ))}
      {hasMore && (
        <li ref={sentinelRef} className="flex justify-center py-2" aria-hidden="true">
          {isLoadingMore && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
        </li>
      )}
    </ul>
  );
}
