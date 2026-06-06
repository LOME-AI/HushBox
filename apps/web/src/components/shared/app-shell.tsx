import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Sidebar } from '@/components/sidebar/sidebar';
import { useModelValidation } from '@/hooks/use-model-validation';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  useModelValidation();

  return (
    <div data-testid={TEST_IDS.appShell} className="bg-background flex h-dvh">
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
