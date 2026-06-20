import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './_app';

const { syncSpy } = vi.hoisted(() => ({ syncSpy: vi.fn() }));

// Keep the real router (createFileRoute must run); stub only the Outlet the
// layout renders, since renderRoute mounts the component without router context.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Outlet: (): React.JSX.Element => <div data-testid="outlet">Outlet Content</div>,
  };
});

// AppShell mounts Sidebar + model-validation hooks that fire live queries; the
// layout's only contract with it is "wrap children", so stub it to a passthrough.
vi.mock('@/components/shared/app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('@/hooks/auth/use-accessibility-sync', () => ({
  useAccessibilitySync: syncSpy,
}));

describe('/_app layout component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the app shell wrapping the outlet', () => {
    renderRoute(Route);

    const shell = screen.getByTestId('app-shell');
    expect(shell).toBeInTheDocument();
    expect(shell).toContainElement(screen.getByTestId('outlet'));
  });

  it('runs the accessibility sync hook on mount', () => {
    renderRoute(Route);

    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});
