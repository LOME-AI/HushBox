import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';

vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <div data-testid="outlet" />,
  createRootRouteWithContext:
    () =>
    (options: { component: React.ComponentType; notFoundComponent: React.ComponentType }) => ({
      component: options.component,
      notFoundComponent: options.notFoundComponent,
    }),
  Navigate: () => null,
  useNavigate: vi.fn(() => vi.fn()),
}));

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

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return { ...actual, ROUTES: { CHAT: '/chat' } };
});

vi.mock('@hushbox/ui/accessibility', () => ({
  A11yProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MotionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AccessibilityWidget: () => null,
  AccessibilityPanel: () => null,
  AccessibilityPage: () => null,
  SvgColorblindDefs: () => null,
}));

vi.mock('@/lib/tts-dom-observer', () => ({
  installTtsDomObserver: () => () => {},
}));

vi.mock('@/components/shared/settled-indicator', () => ({
  SettledIndicator: () => <div data-testid="settled-indicator" />,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, Toaster: () => <div data-testid="toaster" /> };
});

vi.mock('@/stores/touch-override', () => ({
  useTouchOverrideStore: () => null,
}));

describe('root route', () => {
  it('renders OfflineOverlay', async () => {
    const module_ = await import('./__root');
    const route = module_.Route as unknown as { component: React.ComponentType };
    const Component = route.component;
    render(<Component />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
  });

  it('renders UpgradeRequiredModal', async () => {
    const module_ = await import('./__root');
    const route = module_.Route as unknown as { component: React.ComponentType };
    const Component = route.component;
    render(<Component />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();
  });
});
