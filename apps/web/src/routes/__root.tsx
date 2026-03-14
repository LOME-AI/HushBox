import { Outlet, createRootRoute, Navigate } from '@tanstack/react-router';
import { QueryProvider } from '@/providers/query-provider';
import { StabilityProvider, useStability } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { CapacitorProvider } from '@/capacitor';
import { UpgradeRequiredModal } from '@/components/shared/upgrade-required-modal';
import { OfflineOverlay } from '@/components/shared/offline-overlay';
import { ROUTES } from '@hushbox/shared';
import { Toaster } from '@hushbox/ui';
import { SettledIndicator } from '@/components/shared/settled-indicator';

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

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <QueryProvider>
        <StabilityProvider>
          <AppShell />
        </StabilityProvider>
      </QueryProvider>
    </ThemeProvider>
  ),
  notFoundComponent: NotFoundRedirect,
});
