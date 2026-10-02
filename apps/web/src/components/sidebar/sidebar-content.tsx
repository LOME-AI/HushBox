import * as React from 'react';
import { Lock } from 'lucide-react';
import { cn, Separator } from '@hushbox/ui';
import { TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { usePaletteStore } from '@/stores/ui/palette';
import { useSidebarRail } from '@/hooks/ui/use-sidebar-rail';
import { groupConversationsByDate } from '@/lib/chat/conversation-groups';
import { SidebarSearchRow } from '@/components/shared/sidebar-search-row';
import { NewChatButton } from './new-chat-button';
import { ChatList } from './chat-list';
import { ConversationGroup } from './conversation-group';
import { InboxContent } from './inbox-content';
import { LeaveConversationProvider } from './leave-conversation-controller';

type SidebarTab = 'chats' | 'inbox';

// Sidebar-content needs the inbox-only fields (`accepted`, `invitedByUsername`)
// in addition to the base sidebar conversation shape. The base shape is pulled
// from the shared schema so `privilege` stays typed as `MemberPrivilege`; the
// two inbox fields are kept optional here because the upstream conversations
// query historically supplied them only for pending invites.
type Conversation = Pick<
  ConversationListItem,
  'id' | 'title' | 'currentEpoch' | 'updatedAt' | 'privilege' | 'muted' | 'pinned' | 'memberCount'
> & {
  accepted?: boolean;
  invitedByUsername?: string | null;
};

function DecryptingIndicator(): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid={TEST_IDS.decryptingIndicator}
    >
      <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Lock className="h-4 w-4 shrink-0" data-testid={TEST_IDS.decryptingLockIcon} />
        Decrypting...
      </span>
    </div>
  );
}

interface LoadMore {
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

interface ConversationListProps extends LoadMore {
  pinned: readonly Conversation[];
  unpinned: readonly Conversation[];
  activeConversationId?: string | undefined;
  isAuthenticated: boolean;
}

/**
 * Pinned conversations first, untitled, then the rest under their date groups. The next
 * page loads from whichever list ends the body, so the sentinel is always the last row.
 */
function ConversationList({
  pinned,
  unpinned,
  activeConversationId,
  isAuthenticated,
  ...loadMore
}: Readonly<ConversationListProps>): React.JSX.Element {
  if (pinned.length === 0 && unpinned.length === 0) {
    return <ChatList conversations={[]} isAuthenticated={isAuthenticated} />;
  }

  const groups = groupConversationsByDate(unpinned, new Date());
  const lastGroup = groups.at(-1)?.group;

  return (
    <>
      {pinned.length > 0 && (
        <div className="pt-3">
          <ChatList
            conversations={pinned}
            activeId={activeConversationId}
            label="Pinned conversations"
            {...(groups.length === 0 ? loadMore : {})}
          />
        </div>
      )}
      {pinned.length > 0 && groups.length > 0 && (
        <div className="px-2 pt-3">
          <Separator className="bg-sidebar-border" data-testid={TEST_IDS.pinnedSeparator} />
        </div>
      )}
      {groups.map(({ group, items }) => (
        <ConversationGroup
          key={group}
          label={group}
          conversations={items}
          activeId={activeConversationId}
          {...(group === lastGroup ? loadMore : {})}
        />
      ))}
    </>
  );
}

interface SidebarPanelsProps extends LoadMore {
  activeTab: SidebarTab;
  isLoading: boolean;
  pinned: readonly Conversation[];
  unpinned: readonly Conversation[];
  unaccepted: Conversation[];
  activeConversationId?: string | undefined;
  isAuthenticated: boolean;
}

function SidebarPanels({
  activeTab,
  isLoading,
  pinned,
  unpinned,
  unaccepted,
  activeConversationId,
  isAuthenticated,
  ...loadMore
}: Readonly<SidebarPanelsProps>): React.JSX.Element {
  if (isLoading) return <DecryptingIndicator />;

  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-hidden">
      <div
        className={`flex h-full transition-transform duration-300 ease-in-out ${
          activeTab === 'inbox' && unaccepted.length > 0 ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div
          data-testid={TEST_IDS.chatListScrollContainer}
          className="h-full w-full flex-shrink-0 overflow-y-auto pt-1 pb-4"
        >
          <ConversationList
            pinned={pinned}
            unpinned={unpinned}
            activeConversationId={activeConversationId}
            isAuthenticated={isAuthenticated}
            {...loadMore}
          />
        </div>
        {unaccepted.length > 0 && (
          <div className="h-full w-full flex-shrink-0 overflow-y-auto px-1">
            <InboxContent conversations={unaccepted} />
          </div>
        )}
      </div>
    </div>
  );
}

interface SidebarTabSwitchProps {
  activeTab: SidebarTab;
  setActiveTab: (tab: SidebarTab) => void;
  unacceptedCount: number;
}

function SidebarTabSwitch({
  activeTab,
  setActiveTab,
  unacceptedCount,
}: Readonly<SidebarTabSwitchProps>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
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

interface SidebarContentProps extends LoadMore {
  conversations: Conversation[];
  activeConversationId?: string | undefined;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  /** Whether the conversations are still being fetched and decrypted */
  isLoading?: boolean;
}

export function SidebarContent({
  conversations,
  activeConversationId,
  isAuthenticated = true,
  isLoading = false,
  ...loadMore
}: Readonly<SidebarContentProps>): React.JSX.Element {
  const rail = useSidebarRail();
  const openPalette = usePaletteStore((state) => state.setOpen);
  const [activeTab, setActiveTab] = React.useState<SidebarTab>('chats');

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

  return (
    <LeaveConversationProvider>
      {/* Bleeds past the panel body's inset so the rule under Search spans the panel,
          as the head's rule would; the frame draws no head rule on this side. */}
      <nav
        data-testid={TEST_IDS.sidebarNav}
        aria-label="Chat navigation"
        className="-mx-2 -mt-1 flex min-h-0 flex-1 flex-col"
      >
        <div className={cn('flex flex-col gap-2 pb-3', rail ? 'items-center' : 'px-3')}>
          <NewChatButton />
          <SidebarSearchRow
            mode="launcher"
            onOpen={() => {
              openPalette(true);
            }}
            kbd={isAuthenticated ? 'mod+k' : undefined}
            collapsed={rail}
          />
        </div>

        {/* The rail carries New chat and Search and nothing of the list beneath them. */}
        {!rail && (
          <>
            <Separator className="bg-sidebar-border" />

            {unaccepted.length > 0 && (
              <SidebarTabSwitch
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                unacceptedCount={unaccepted.length}
              />
            )}

            <SidebarPanels
              activeTab={activeTab}
              isLoading={isLoading}
              pinned={accepted.filter((c) => c.pinned)}
              unpinned={accepted.filter((c) => !c.pinned)}
              unaccepted={unaccepted}
              activeConversationId={activeConversationId}
              isAuthenticated={isAuthenticated}
              {...loadMore}
            />
          </>
        )}
      </nav>
    </LeaveConversationProvider>
  );
}
