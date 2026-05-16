import * as React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/shared/app-shell';
import { useAccessibilitySync } from '@/hooks/use-accessibility-sync';

export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout(): React.JSX.Element {
  useAccessibilitySync();
  return (
    <div className="h-dvh overflow-hidden">
      <AppShell>
        <Outlet />
      </AppShell>
    </div>
  );
}
