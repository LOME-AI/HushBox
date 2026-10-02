import * as React from 'react';
import { Outlet, createRootRouteWithContext, Navigate } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { Toaster, TouchDeviceOverrideContext } from '@hushbox/ui';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { QueryProvider } from '@/providers/query-provider';
import { StabilityProvider, useStability } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { CapacitorProvider } from '@/capacitor';
import { UpgradeRequiredModal } from '@/components/shared/upgrade-required-modal';
import { OfflineOverlay } from '@/components/shared/offline-overlay';
import { RouteAnnouncer } from '@/components/shared/route-announcer';
import { AnnouncementBanner } from '@/components/banner/announcement-banner';
import { CrawlerEye } from '@/components/dev/crawler-eye';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { useStreamCycleActivityStore } from '@/stores/activity/stream-cycle';
import { useTouchOverrideStore } from '@/stores/ui/touch-override';
import type { RouterContext } from '@/router';

function NotFoundRedirect(): React.JSX.Element {
  return <Navigate to={ROUTES.CHAT} />;
}

function AppShell(): React.JSX.Element {
  const { isAppStable } = useStability();
  // Sign-out reloads the page in place and each route decides where that lands,
  // so nothing about the URL says whether a session is held. The shell is the
  // one node on every route, which is what makes it the place to say so.
  const { isAuthenticated, isStable } = useStableSession();
  // A new-chat page renders no message list, so the shell is the only place a
  // spec can read the cycle count before the first send.
  const streamsCompleted = useStreamCycleActivityStore((s) => s.streamsCompleted);
  return (
    <CapacitorProvider isAppStable={isAppStable}>
      {/* Flex column so the banner is a non-growing row above all route content.
          When no banner is active the mount node is empty (height 0), so this is
          a no-op for the common case. */}
      <div
        data-signed-out={String(isStable && !isAuthenticated)}
        data-streams-completed={streamsCompleted}
        className="flex h-dvh flex-col"
      >
        <AnnouncementBanner />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RouteAnnouncer />
          <Outlet />
        </div>
      </div>
      <Toaster />
      <UpgradeRequiredModal />
      <OfflineOverlay />
      <CrawlerEye />
    </CapacitorProvider>
  );
}

function RootComponent(): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);

  return (
    <TouchDeviceOverrideContext value={touchOverride}>
      <MotionProvider>
        <ThemeProvider>
          <QueryProvider>
            <StabilityProvider>
              <A11yProvider>
                <AppShell />
              </A11yProvider>
            </StabilityProvider>
          </QueryProvider>
        </ThemeProvider>
      </MotionProvider>
    </TouchDeviceOverrideContext>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundRedirect,
});
