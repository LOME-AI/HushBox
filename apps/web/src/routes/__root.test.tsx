import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { useStreamCycleActivityStore } from '@/stores/activity/stream-cycle';
import { Route } from './__root';

// __root uses createRootRouteWithContext (the root route is always eager, so the
// code-splitting guardrail exempts it). Keep the real router so the route object
// is genuine, and source RootComponent from Route.options.component — but the
// component still renders Outlet/Navigate/useRouter, which need router context
// renderRoute/render does not provide, so those are stubbed here. The full
// provider tree is likewise stubbed to pass-throughs: this test asserts the
// shell's always-on regions render, not the providers' internals.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
    useNavigate: vi.fn(() => vi.fn()),
    useRouter: () => ({ subscribe: vi.fn(() => vi.fn()) }),
  };
});

vi.mock('@/providers/query-provider', () => ({
  QueryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/providers/stability-provider', () => ({
  StabilityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useStability: () => ({ isAppStable: true }),
}));

vi.mock('@/providers/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/capacitor', () => ({
  CapacitorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/shared/upgrade-required-modal', () => ({
  UpgradeRequiredModal: () => <div data-testid="upgrade-required-modal" />,
}));

vi.mock('@/components/shared/offline-overlay', () => ({
  OfflineOverlay: () => <div data-testid="offline-overlay" />,
}));

vi.mock('@/components/banner/announcement-banner', () => ({
  AnnouncementBanner: () => <div data-testid="announcement-banner" />,
}));

vi.mock('@hushbox/ui/accessibility', () => ({
  A11yProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MotionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SvgColorblindDefs: () => null,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, Toaster: () => <div data-testid="toaster" /> };
});

const mockStableSession = { isAuthenticated: false, isStable: false };

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: () => mockStableSession,
}));

vi.mock('@/stores/ui/touch-override', () => ({
  // Invoke the selector so RootComponent's `(state) => state.override` runs
  // against a real (empty-override) state shape rather than being bypassed.
  useTouchOverrideStore: (selector: (state: { override: unknown }) => unknown) =>
    selector({ override: null }),
}));

describe('root route', () => {
  const RootComponent = Route.options.component as React.ComponentType;

  it('renders OfflineOverlay', () => {
    render(<RootComponent />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
  });

  it('renders UpgradeRequiredModal', () => {
    render(<RootComponent />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();
  });

  it('renders the route announcer live region', () => {
    render(<RootComponent />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('redirects unmatched routes to chat via the notFoundComponent', () => {
    // Navigate is stubbed above as an element carrying its target, so rendering
    // the notFoundComponent exercises NotFoundRedirect itself and exposes the
    // destination it hands the router, without needing a live router.
    const NotFound = Route.options.notFoundComponent as React.ComponentType;
    expect(NotFound).toBeDefined();

    render(<NotFound />);

    expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
  });

  it('reports signed out once auth has settled with no session', () => {
    mockStableSession.isStable = true;
    mockStableSession.isAuthenticated = false;

    render(<RootComponent />);

    const shell = screen.getByTestId('announcement-banner').parentElement;
    expect(shell).toHaveAttribute(TEST_SIGNALS.signedOut, 'true');
  });

  it('does not report signed out while auth is still being determined', () => {
    mockStableSession.isStable = false;
    mockStableSession.isAuthenticated = false;

    render(<RootComponent />);

    const shell = screen.getByTestId('announcement-banner').parentElement;
    expect(shell).toHaveAttribute(TEST_SIGNALS.signedOut, 'false');
  });

  it('does not report signed out for a settled authenticated session', () => {
    mockStableSession.isStable = true;
    mockStableSession.isAuthenticated = true;

    render(<RootComponent />);

    const shell = screen.getByTestId('announcement-banner').parentElement;
    expect(shell).toHaveAttribute(TEST_SIGNALS.signedOut, 'false');
  });

  it('reports the stream-cycle count on the shell', () => {
    useStreamCycleActivityStore.setState({ streamsCompleted: 3 });

    render(<RootComponent />);

    const shell = screen.getByTestId('announcement-banner').parentElement;
    expect(shell).toHaveAttribute(TEST_SIGNALS.streamsCompleted, '3');
  });

  it('advances the shell stream-cycle count when a cycle completes', () => {
    useStreamCycleActivityStore.setState({ streamsCompleted: 0 });
    render(<RootComponent />);

    act(() => {
      useStreamCycleActivityStore.getState().markStreamCycleComplete();
    });

    const shell = screen.getByTestId('announcement-banner').parentElement;
    expect(shell).toHaveAttribute(TEST_SIGNALS.streamsCompleted, '1');
  });

  it('wraps the banner row and outlet in the viewport-height contract', () => {
    render(<RootComponent />);

    // The wrapper around the banner owns the mobile viewport-height contract
    // (h-dvh moved here off AppShell, which is h-full inside it); the content
    // region's min-h-0 flex-1 is the other half — without it the banner row
    // pushes route content past the viewport instead of shrinking it.
    const viewport = screen.getByTestId('announcement-banner').parentElement;
    expect(viewport).toHaveClass('h-dvh');
    expect(viewport).toHaveClass('flex');
    expect(viewport).toHaveClass('flex-col');

    const contentRegion = screen.getByTestId('outlet').parentElement;
    expect(contentRegion).toHaveClass('min-h-0');
    expect(contentRegion).toHaveClass('flex-1');
  });
});
