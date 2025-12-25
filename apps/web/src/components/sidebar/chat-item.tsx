import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@lome-chat/ui';
import { MessageSquare } from 'lucide-react';
import { useUIStore } from '@/stores/ui';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatItemProps {
  conversation: Conversation;
  isActive?: boolean;
}

export function ChatItem({ conversation, isActive }: ChatItemProps): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  return (
    <Link
      to="/chat/$conversationId"
      params={{ conversationId: conversation.id }}
      data-testid="chat-link"
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'hover:bg-sidebar-border/50 transition-colors',
        isActive && 'bg-sidebar-border',
        !sidebarOpen && 'justify-center px-0'
      )}
    >
      <MessageSquare data-testid="message-icon" className="h-4 w-4 shrink-0" aria-hidden="true" />
      {sidebarOpen && <span className="truncate">{conversation.title}</span>}
    </Link>
  );
}
