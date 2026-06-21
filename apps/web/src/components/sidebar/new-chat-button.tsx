import * as React from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useIsMobile } from '@hushbox/ui';
import { useUIStore } from '@/stores/ui';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';

export function NewChatButton(): React.JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);

  const handleClick = (event: React.MouseEvent): void => {
    // Let modified clicks (cmd/ctrl/shift) and non-primary buttons fall through
    // to the anchor's href so the browser opens /chat in a new tab/window.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (isMobile && pathname === ROUTES.CHAT) {
      setMobileSidebarOpen(false);
      return;
    }
    void navigate({ to: ROUTES.CHAT });
  };

  return (
    <SidebarActionButton
      icon={<Plus data-testid={TEST_IDS.plusIcon} className="h-4 w-4" aria-hidden="true" />}
      label="New Chat"
      href={ROUTES.CHAT}
      onClick={handleClick}
      collapsed={!sidebarOpen}
    />
  );
}
