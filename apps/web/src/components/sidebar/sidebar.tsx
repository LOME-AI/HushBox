import * as React from 'react';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { cn, Logo, ReleaseStageBadge, SidebarPanel } from '@hushbox/ui';
import { useFormFactor } from '@hushbox/ui/platform';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui/ui';
import { useRightPane } from '@/stores/ui/right-pane';
import { useExpandSidebar, useSidebarRail } from '@/hooks/ui/use-sidebar-rail';
import { useDecryptedConversations, chatKeys } from '@/hooks/chat/chat';
import { useSession } from '@/lib/auth/auth';
import { SidebarPromptSlot } from '@/components/prompts/sidebar-prompt-slot';
import { ExternalPageLink } from '@/components/shared/external-page-link';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';

/**
 * Last in the body, so whatever prompt is due sits between the conversation list and the
 * account footer. The rail cannot carry a card's copy, so it carries a stand-in that
 * expands the sidebar instead; the mobile drawer is full width and always gets the card.
 * Capped at half the body, the card scrolls in a short window or at a large text size
 * rather than covering New chat, Search and the list; the rail's stand-in is left
 * unclipped so its focus ring shows, in a column so its own `self-center` centres it on the
 * rail with the controls above it.
 */
function PromptHolder({ collapsed }: Readonly<{ collapsed: boolean }>): React.JSX.Element {
  return (
    <div className={cn('shrink-0', collapsed ? 'flex flex-col' : 'max-h-1/2 overflow-y-auto')}>
      <SidebarPromptSlot collapsed={collapsed} />
    </div>
  );
}

/**
 * What the desktop head's control does. Over a docked pane it expands, since a toggle
 * there would flip a saved choice the fold hides; otherwise it toggles.
 */
function useDesktopHeadControl(): () => void {
  const paneDocked = useRightPane((state) => state.active !== null);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const expandSidebar = useExpandSidebar();
  return paneDocked ? expandSidebar : toggleSidebar;
}

export function Sidebar(): React.JSX.Element {
  // The frame decides the phone drawer from this same band; `useSidebarDrawer` answers
  // only inside the panel, and this component is the one that renders it.
  const isMobile = useFormFactor().band === 'phone';
  const { mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();
  const collapsed = useSidebarRail();
  const onHeadControl = useDesktopHeadControl();
  const {
    data: conversations,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDecryptedConversations();
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!isAuthenticated && !isSessionPending) {
      queryClient.removeQueries({ queryKey: chatKeys.conversations() });
    }
  }, [isAuthenticated, isSessionPending, queryClient]);

  // The sidebar renders on every route, so read the `$id` param non-strictly:
  // it resolves to the open conversation on `/chat/$id` and to undefined elsewhere.
  const { id: activeConversationId } = useParams({ strict: false });

  const { pathname } = useLocation();
  const previousPathnameRef = React.useRef(pathname);
  React.useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname, setMobileSidebarOpen]);

  // Clear stale pointer-events left by react-remove-scroll after Sheet close animation.
  // react-remove-scroll applies a CSS class (.block-interactivity-N) with pointer-events: none
  // to <html> while the Sheet is open. Its React cleanup doesn't fire reliably after Radix
  // Presence unmounts the Sheet content, leaving all clicks on the page blocked.
  React.useEffect(() => {
    if (mobileSidebarOpen) return;
    const timer = setTimeout(() => {
      document.documentElement.style.pointerEvents = '';
      document.body.style.pointerEvents = '';
      for (const el of [document.documentElement, document.body]) {
        // Snapshot class list before mutating (removing during iteration)
        const classes = [...el.classList] as string[];
        for (const cls of classes) {
          if (cls.startsWith('block-interactivity')) el.classList.remove(cls);
        }
      }
    }, 350);
    return () => {
      clearTimeout(timer);
    };
  }, [mobileSidebarOpen]);

  // Radix cleanup — prevent stale body styles when component unmounts mid-transition
  React.useLayoutEffect(() => {
    return () => {
      document.body.style.overflow = '';
      document.body.style.pointerEvents = '';
      document.body.style.paddingRight = '';
      delete document.body.dataset['scrollLocked'];
    };
  }, []);

  return (
    <SidebarPanel
      side="left"
      open={isMobile ? mobileSidebarOpen : true}
      onOpenChange={
        /* v8 ignore start -- desktop SidebarPanel renders a plain aside (never a Sheet), so the noop arm is never invoked; it exists only to satisfy the required prop */
        isMobile
          ? setMobileSidebarOpen
          : () => {
              /* noop — desktop sidebar always open */
            }
        /* v8 ignore stop */
      }
      collapsed={collapsed}
      ariaLabel="Conversations"
      headerIcon={
        <>
          {/* The router's active match is prefix-by-segment: without `exact` this
              link is also "current" on /chat/$id, marking two current pages in one region. */}
          <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat" activeOptions={{ exact: true }}>
            <Logo />
          </Link>
          <ReleaseStageBadge
            link={({ href, ...props }) => <ExternalPageLink path={href} {...props} />}
          />
        </>
      }
      onClose={
        isMobile
          ? () => {
              setMobileSidebarOpen(false);
            }
          : onHeadControl
      }
      footer={<SidebarFooter />}
      // The rule sits under the Search row instead, where the body's own nav draws it.
      headerRule={false}
      testId={TEST_IDS.sidebar}
    >
      <SidebarContent
        conversations={isAuthenticated ? (conversations ?? []) : []}
        activeConversationId={activeConversationId}
        isAuthenticated={isAuthenticated}
        isLoading={isAuthenticated && isLoading}
        onLoadMore={fetchNextPage}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
      />
      <PromptHolder collapsed={collapsed} />
    </SidebarPanel>
  );
}
