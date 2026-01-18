import * as React from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { MobileSidebar } from '@/components/sidebar/mobile-sidebar';
import { useModelValidation } from '@/hooks/use-model-validation';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  // Validate cached model selection on mount and when user tier changes
  useModelValidation();

  return (
    <div data-testid="app-shell" className="bg-background flex h-dvh">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile sidebar overlay */}
      <MobileSidebar />

      {/* Main content area */}
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
