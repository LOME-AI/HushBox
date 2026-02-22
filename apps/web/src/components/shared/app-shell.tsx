import * as React from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { useModelValidation } from '@/hooks/use-model-validation';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  // Validate cached model selection on mount and when user tier changes
  useModelValidation();

  return (
    <div data-testid="app-shell" className="bg-background flex h-dvh">
      {/* Unified sidebar (handles desktop and mobile) */}
      <Sidebar />

      {/* Main content area */}
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>

      {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
      <div id="right-sidebar-portal" className="contents" />
    </div>
  );
}
