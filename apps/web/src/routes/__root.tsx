import { Outlet, createRootRoute, Navigate } from '@tanstack/react-router';
import { QueryProvider } from '@/providers/query-provider';
import { StabilityProvider } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { ROUTES } from '@hushbox/shared';
import { Toaster } from '@hushbox/ui';
import { SettledIndicator } from '@/components/shared/settled-indicator';

function NotFoundRedirect(): React.JSX.Element {
  return <Navigate to={ROUTES.CHAT} />;
}

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <QueryProvider>
        <StabilityProvider>
          <Outlet />
          <Toaster />
          <SettledIndicator />
        </StabilityProvider>
      </QueryProvider>
    </ThemeProvider>
  ),
  notFoundComponent: NotFoundRedirect,
});
