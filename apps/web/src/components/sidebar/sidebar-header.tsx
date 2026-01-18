import * as React from 'react';
import { Button, cn } from '@lome-chat/ui';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Logo } from '@/components/shared/logo';
import { ROUTES } from '@/lib/routes';

export function SidebarHeader(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);

  return (
    <div
      data-testid="sidebar-header"
      className={cn(
        'border-sidebar-border flex h-[53px] shrink-0 items-center border-b px-4',
        sidebarOpen ? 'justify-between' : 'justify-center'
      )}
    >
      {sidebarOpen ? (
        <>
          <Logo asLink to={ROUTES.CHAT} />
          <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="Collapse sidebar">
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="Expand sidebar">
          <PanelLeft className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
