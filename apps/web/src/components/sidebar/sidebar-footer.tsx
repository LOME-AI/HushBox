import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { User } from 'lucide-react';
import { useUIStore } from '@/stores/ui';

export function SidebarFooter(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  return (
    <div
      data-testid="sidebar-footer"
      className={cn('border-sidebar-border border-t p-4', !sidebarOpen && 'flex justify-center')}
    >
      {sidebarOpen ? (
        <span className="text-sidebar-foreground/70 text-sm">User menu placeholder</span>
      ) : (
        <User data-testid="user-icon" className="text-sidebar-foreground/70 h-4 w-4" />
      )}
    </div>
  );
}
