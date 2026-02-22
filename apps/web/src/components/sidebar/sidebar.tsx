import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useDecryptedConversations } from '@/hooks/chat';
import { useSession } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { SidebarPanel } from '@/components/shared/sidebar-panel';
import { Logo } from '@hushbox/ui';
import { ROUTES } from '@hushbox/shared';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';

function SidebarLoadingIndicator({
  collapsed,
}: Readonly<{ collapsed: boolean }>): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="decrypting-indicator">
      {collapsed ? (
        <Lock
          className="text-muted-foreground h-5 w-5 animate-pulse"
          data-testid="decrypting-lock-icon"
        />
      ) : (
        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Lock className="h-4 w-4 shrink-0" data-testid="decrypting-lock-icon" />
          Decrypting...
        </span>
      )}
    </div>
  );
}

export function Sidebar(): React.JSX.Element {
  const isMobile = useIsMobile();
  const { sidebarOpen, toggleSidebar, mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();
  const { data: conversations, isLoading } = useDecryptedConversations();
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const collapsed = !isMobile && !sidebarOpen;

  // Auto-close mobile sidebar on navigation
  const { pathname } = useLocation();
  const previousPathnameRef = React.useRef(pathname);
  React.useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname, setMobileSidebarOpen]);

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
        isMobile
          ? setMobileSidebarOpen
          : () => {
              /* noop — desktop sidebar always open */
            }
      }
      collapsed={collapsed}
      headerIcon={
        <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
          <Logo />
        </Link>
      }
      onClose={
        isMobile
          ? () => {
              setMobileSidebarOpen(false);
            }
          : toggleSidebar
      }
      footer={<SidebarFooter />}
      testId="sidebar"
    >
      {isLoading ? (
        <SidebarLoadingIndicator collapsed={collapsed} />
      ) : (
        <SidebarContent conversations={conversations ?? []} isAuthenticated={isAuthenticated} />
      )}
    </SidebarPanel>
  );
}
