import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

// Mock all dependencies to isolate the root route composition
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <div data-testid="outlet" />,
  createRootRoute: (options: {
    component: React.ComponentType;
    notFoundComponent: React.ComponentType;
  }) => ({
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

vi.mock('@hushbox/shared', () => ({
  ROUTES: { CHAT: '/chat' },
}));

describe('root route', () => {
  it('renders OfflineOverlay', async () => {
    const module_ = await import('./__root');
    const route = module_.Route as unknown as { component: React.ComponentType };
    const Component = route.component;
    render(<Component />);

    expect(screen.getByTestId('offline-overlay')).toBeInTheDocument();
  });

  it('renders UpgradeRequiredModal', async () => {
    const module_ = await import('./__root');
    const route = module_.Route as unknown as { component: React.ComponentType };
    const Component = route.component;
    render(<Component />);

    expect(screen.getByTestId('upgrade-required-modal')).toBeInTheDocument();
  });
});
