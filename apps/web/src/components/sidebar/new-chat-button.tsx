import * as React from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { ROUTES } from '@hushbox/shared';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';

export function NewChatButton(): React.JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);

  const handleClick = (): void => {
    if (isMobile && pathname === ROUTES.CHAT) {
      setMobileSidebarOpen(false);
      return;
    }
    void navigate({ to: ROUTES.CHAT });
  };

  return (
    <SidebarActionButton
      icon={<Plus data-testid="plus-icon" className="h-4 w-4" aria-hidden="true" />}
      label="New Chat"
      onClick={handleClick}
      collapsed={!sidebarOpen}
    />
  );
}
