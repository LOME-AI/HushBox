import * as React from 'react';
import { cn, Input, Separator } from '@hushbox/ui';
import { Search } from 'lucide-react';
import { FEATURE_FLAGS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { NewChatButton } from './new-chat-button';
import { ChatList } from './chat-list';
import { ProjectsLink } from './projects-link';
import { InboxContent } from './inbox-content';

type SidebarTab = 'chats' | 'inbox';

interface Conversation {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  privilege: string;
  accepted?: boolean;
  invitedByUsername?: string | null;
  muted: boolean;
}

interface FilteredConversations {
  filteredAccepted: Conversation[];
  filteredUnaccepted: Conversation[];
}

function filterConversationsBySearch(
  accepted: Conversation[],
  unaccepted: Conversation[],
  searchQuery: string
): FilteredConversations {
  if (!searchQuery) return { filteredAccepted: accepted, filteredUnaccepted: unaccepted };
  const query = searchQuery.toLowerCase();
  return {
    filteredAccepted: accepted.filter((c) => c.title.toLowerCase().includes(query)),
    filteredUnaccepted: unaccepted.filter((c) => {
      return (
        c.title.toLowerCase().includes(query) ||
        (c.invitedByUsername?.toLowerCase().includes(query) ?? false)
      );
    }),
  };
}

interface SidebarPanelsProps {
  activeTab: SidebarTab;
  unacceptedCount: number;
  sidebarOpen: boolean;
  filteredAccepted: Conversation[];
  filteredUnaccepted: Conversation[];
  activeConversationId?: string | undefined;
  isAuthenticated: boolean;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

function SidebarPanels({
  activeTab,
  unacceptedCount,
  sidebarOpen,
  filteredAccepted,
  filteredUnaccepted,
  activeConversationId,
  isAuthenticated,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: Readonly<SidebarPanelsProps>): React.JSX.Element {
  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-hidden">
      <div
        className={`flex h-full transition-transform duration-300 ease-in-out ${
          activeTab === 'inbox' && unacceptedCount > 0 ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div
          data-testid="chat-list-scroll-container"
          className={cn(
            'h-full w-full flex-shrink-0 overflow-y-auto',
            !sidebarOpen && 'scrollbar-hide'
          )}
        >
          <ChatList
            conversations={filteredAccepted}
            activeId={activeConversationId}
            isAuthenticated={isAuthenticated}
            onLoadMore={onLoadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
          />
        </div>
        {unacceptedCount > 0 && (
          <div className="h-full w-full flex-shrink-0 overflow-y-auto px-1">
            <InboxContent conversations={filteredUnaccepted} />
          </div>
        )}
      </div>
    </div>
  );
}

interface SidebarContentProps {
  conversations: Conversation[];
  activeConversationId?: string;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

interface SidebarTabHeaderProps {
  activeTab: SidebarTab;
  setActiveTab: (tab: SidebarTab) => void;
  unacceptedCount: number;
}

function SidebarTabHeader({
  activeTab,
  setActiveTab,
  unacceptedCount,
}: Readonly<SidebarTabHeaderProps>): React.JSX.Element {
  if (unacceptedCount === 0) {
    return (
      <h2 className="text-sidebar-foreground/60 px-2 text-xs font-medium tracking-wide uppercase">
        Recent Chats
      </h2>
    );
  }

  return (
    <div className="flex items-center justify-between px-2">
      <button
        className={`text-xs font-medium tracking-wide uppercase transition-colors ${
          activeTab === 'chats'
            ? 'text-sidebar-foreground'
            : 'text-sidebar-foreground/40 hover:text-sidebar-foreground/60'
        }`}
        onClick={() => {
          setActiveTab('chats');
        }}
      >
        Recent Chats
      </button>
      <button
        className={`flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase transition-colors ${
          activeTab === 'inbox'
            ? 'text-sidebar-foreground'
            : 'text-sidebar-foreground/40 hover:text-sidebar-foreground/60'
        }`}
        onClick={() => {
          setActiveTab('inbox');
        }}
      >
        Invites
        <span className="bg-primary text-primary-foreground inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded-full px-1 text-[10px] font-bold">
          {unacceptedCount}
        </span>
      </button>
    </div>
  );
}

export function SidebarContent({
  conversations,
  activeConversationId,
  isAuthenticated = true,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: Readonly<SidebarContentProps>): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<SidebarTab>('chats');

  // Split conversations by acceptance status
  const accepted = conversations.filter((c) => c.accepted !== false);
  const unaccepted = conversations.filter((c) => c.accepted === false);

  // Auto-switch to chats when last invite is handled
  const previousUnacceptedCount = React.useRef(unaccepted.length);
  React.useEffect(() => {
    if (previousUnacceptedCount.current > 0 && unaccepted.length === 0 && activeTab === 'inbox') {
      setActiveTab('chats');
    }
    previousUnacceptedCount.current = unaccepted.length;
  }, [unaccepted.length, activeTab]);

  // Filter by search (applies to active tab's content)
  const { filteredAccepted, filteredUnaccepted } = filterConversationsBySearch(
    accepted,
    unaccepted,
    searchQuery
  );

  return (
    <nav
      data-testid="sidebar-nav"
      aria-label="Chat navigation"
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className={sidebarOpen ? 'flex flex-col gap-3' : 'flex flex-col items-center gap-3'}>
        <NewChatButton />
        {sidebarOpen && (
          <Input
            icon={<Search className="h-5 w-5" aria-hidden="true" />}
            label="Search chats"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
          />
        )}
      </div>

      <Separator className="bg-sidebar-border" />

      {sidebarOpen && (
        <SidebarTabHeader
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          unacceptedCount={unaccepted.length}
        />
      )}

      <SidebarPanels
        activeTab={activeTab}
        unacceptedCount={unaccepted.length}
        sidebarOpen={sidebarOpen}
        filteredAccepted={filteredAccepted}
        filteredUnaccepted={filteredUnaccepted}
        activeConversationId={activeConversationId}
        isAuthenticated={isAuthenticated}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
      />

      {FEATURE_FLAGS.PROJECTS_ENABLED && (
        <>
          <Separator className="bg-sidebar-border" />

          <div className={sidebarOpen ? '' : 'flex justify-center'}>
            <ProjectsLink />
          </div>
        </>
      )}
    </nav>
  );
}
