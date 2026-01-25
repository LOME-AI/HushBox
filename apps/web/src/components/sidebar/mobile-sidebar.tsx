import * as React from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@lome-chat/ui';
import { useUIStore } from '@/stores/ui';
import { useConversations } from '@/hooks/chat';
import { useSession } from '@/lib/auth';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';
import { Logo } from '@/components/shared/logo';
import { ROUTES } from '@/lib/routes';

export function MobileSidebar(): React.JSX.Element {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();
  const { data: conversations, isLoading } = useConversations();
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  React.useEffect(() => {
    if (mobileSidebarOpen) {
      useUIStore.setState({ sidebarOpen: true });
    }
  }, [mobileSidebarOpen]);

  // Force cleanup of Radix UI's body modifications on unmount.
  // Radix Dialog sets overflow:hidden and pointer-events on body when open.
  // If the component unmounts during navigation before Radix can clean up,
  // these styles persist and block interactions on the new page.
  React.useLayoutEffect(() => {
    return () => {
      document.body.style.overflow = '';
      document.body.style.pointerEvents = '';
      document.body.style.paddingRight = '';
      delete document.body.dataset['scrollLocked'];
    };
  }, []);

  return (
    <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
      <SheetContent
        side="left"
        className="bg-sidebar text-sidebar-foreground flex w-72 flex-col p-0"
        data-testid="mobile-sidebar"
      >
        <SheetHeader className="border-sidebar-border border-b px-4 py-3">
          <SheetTitle asChild>
            <Logo asLink to={ROUTES.CHAT} />
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-sidebar-foreground/50 text-sm">Loading...</span>
          </div>
        ) : (
          <SidebarContent conversations={conversations ?? []} isAuthenticated={isAuthenticated} />
        )}

        <SidebarFooter />
      </SheetContent>
    </Sheet>
  );
}
