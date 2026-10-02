import * as React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/shared/app-shell';
import { PageShell } from '@/components/shared/page-shell';
import { useAccessibilitySync } from '@/hooks/auth/use-accessibility-sync';

export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout(): React.JSX.Element {
  useAccessibilitySync();
  return (
    <div className="h-full overflow-hidden">
      <AppShell>
        <PageShell>
          <Outlet />
        </PageShell>
      </AppShell>
    </div>
  );
}
