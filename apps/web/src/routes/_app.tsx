import * as React from 'react';
import { Outlet, createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/shared/app-shell';

export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout(): React.JSX.Element {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
