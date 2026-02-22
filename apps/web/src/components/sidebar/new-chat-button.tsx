import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { ROUTES } from '@hushbox/shared';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';

export function NewChatButton(): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  const handleClick = (): void => {
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
