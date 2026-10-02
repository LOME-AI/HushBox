import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
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

  it('renders every page inside the page shell region', () => {
    renderRoute(Route);

    const region = document.querySelector('[data-page-slot="region"]');
    expect(region).toContainElement(screen.getByTestId('outlet'));
  });

  it('renders the page shell inside the app shell', () => {
    renderRoute(Route);

    expect(screen.getByTestId('app-shell')).toContainElement(screen.getByTestId('page-header'));
  });

  it('draws the menu button, since every app page has the drawer', () => {
    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.hamburgerButton)).toBeInTheDocument();
  });

  it('runs the accessibility sync hook on mount', () => {
    renderRoute(Route);

    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});

// Every page under the layout gets its shell from the layout, so no page draws a
// second one.
const APP_ROUTE_SOURCES = import.meta.glob<string>(['./_app/*.tsx', '!./_app/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('/_app pages', () => {
  it('reads the app route sources', () => {
    expect(Object.keys(APP_ROUTE_SOURCES)).toContain('./_app/settings.tsx');
  });

  it.each(Object.entries(APP_ROUTE_SOURCES))('%s does not import the page shell', (_, source) => {
    expect(source).not.toMatch(/page-shell/);
  });
});
