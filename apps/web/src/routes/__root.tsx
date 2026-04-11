import * as React from 'react';
import { Outlet, createRootRouteWithContext, Navigate } from '@tanstack/react-router';
import type { RouterContext } from '@/router';
import { QueryProvider } from '@/providers/query-provider';
import { StabilityProvider, useStability } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { CapacitorProvider } from '@/capacitor';
import { UpgradeRequiredModal } from '@/components/shared/upgrade-required-modal';
import { OfflineOverlay } from '@/components/shared/offline-overlay';
import { ROUTES } from '@hushbox/shared';
import { Toaster, TouchDeviceOverrideContext } from '@hushbox/ui';
import { SettledIndicator } from '@/components/shared/settled-indicator';
import { useTouchOverrideStore } from '@/stores/touch-override';

function NotFoundRedirect(): React.JSX.Element {
  return <Navigate to={ROUTES.CHAT} />;
}

function AppShell(): React.JSX.Element {
  const { isAppStable } = useStability();
  return (
    <CapacitorProvider isAppStable={isAppStable}>
      <Outlet />
      <Toaster />
      <SettledIndicator />
      <UpgradeRequiredModal />
      <OfflineOverlay />
    </CapacitorProvider>
  );
}

function RootComponent(): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);

  return (
    <TouchDeviceOverrideContext value={touchOverride}>
      <ThemeProvider>
        <QueryProvider>
          <StabilityProvider>
            <AppShell />
          </StabilityProvider>
        </QueryProvider>
      </ThemeProvider>
    </TouchDeviceOverrideContext>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundRedirect,
});
