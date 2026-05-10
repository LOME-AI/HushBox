import * as React from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { useModelValidation } from '@/hooks/use-model-validation';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  useModelValidation();

  return (
    <div data-testid="app-shell" className="bg-background flex h-dvh">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>

      {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
      <div id="right-sidebar-portal" className="contents" />
    </div>
  );
}
