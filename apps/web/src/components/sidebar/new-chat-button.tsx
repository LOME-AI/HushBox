import * as React from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { SquarePen } from 'lucide-react';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useSidebarDrawer } from '@hushbox/ui';
import { useSidebarRail } from '@/hooks/ui/use-sidebar-rail';
import { SidebarActionRow } from '@/components/shared/sidebar-action-row';

export function NewChatButton(): React.JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const drawer = useSidebarDrawer();
  const rail = useSidebarRail();

  const handleClick = (event: React.MouseEvent): void => {
    // Let modified clicks (cmd/ctrl/shift) and non-primary buttons fall through
    // to the anchor's href so the browser opens /chat in a new tab/window.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    drawer.close();
    if (drawer.isDrawer && pathname === ROUTES.CHAT) {
      return;
    }
    void navigate({ to: ROUTES.CHAT });
  };

  return (
    <SidebarActionRow
      icon={SquarePen}
      label="New chat"
      href={ROUTES.CHAT}
      onClick={handleClick}
      kbd="mod+shift+o"
      collapsed={rail}
      testId={TEST_IDS.newChatRow}
    />
  );
}
