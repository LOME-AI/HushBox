import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@lome-chat/ui';
import { FolderOpen } from 'lucide-react';
import { useUIStore } from '@/stores/ui';

export function ProjectsLink(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  return (
    <Link
      to="/projects"
      data-testid="projects-link"
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'hover:bg-sidebar-border/50 transition-colors',
        !sidebarOpen && 'justify-center px-0'
      )}
    >
      <FolderOpen data-testid="folder-icon" className="h-4 w-4 shrink-0" />
      {sidebarOpen && <span>Projects</span>}
    </Link>
  );
}
