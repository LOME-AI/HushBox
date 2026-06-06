import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';

export function ProjectsLink(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  return (
    <Link
      to={ROUTES.PROJECTS}
      data-testid={TEST_IDS.projectsLink}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'hover:bg-sidebar-border/50 transition-colors',
        !sidebarOpen && 'justify-center px-0'
      )}
    >
      <FolderOpen data-testid={TEST_IDS.folderIcon} className="h-4 w-4 shrink-0" />
      {sidebarOpen && <span>Projects</span>}
    </Link>
  );
}
