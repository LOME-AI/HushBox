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

      {/* Main content area — min-h-0 prevents flex items from inheriting their
          children's min-content height and pushing past the allocated h-dvh
          (paired with the html/body overflow-hidden cap in app.css). */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>

      {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
      <div id="right-sidebar-portal" className="contents" />
    </div>
  );
}
