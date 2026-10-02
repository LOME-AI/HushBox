import * as React from 'react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { ChatList } from './chat-list';
import type { SidebarConversation } from './chat-item';

interface ConversationGroupProps {
  label: string;
  conversations: readonly SidebarConversation[];
  activeId?: string | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

/** One date group of the sidebar's conversations: its title, then its rows in the order given. */
export function ConversationGroup({
  label,
  conversations,
  activeId,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: Readonly<ConversationGroupProps>): React.JSX.Element {
  const titleId = React.useId();

  return (
    <div data-testid={TEST_ID_BUILDERS.conversationGroup(label)} className="pt-3">
      <h2
        id={titleId}
        className="text-muted-foreground px-4.5 pt-1 pb-1.5 font-sans text-xs font-semibold"
      >
        {label}
      </h2>
      <ChatList
        conversations={conversations}
        activeId={activeId}
        labelledBy={titleId}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
      />
    </div>
  );
}
