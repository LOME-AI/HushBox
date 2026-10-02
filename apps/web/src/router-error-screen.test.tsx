import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouterProvider } from '@tanstack/react-router';

// The generated tree is replaced by a root with one child route that throws and
// declares no error component, so the only error screen it can reach is the
// router's default.
vi.mock('./routeTree.gen', async () => {
  const { createRootRoute, createRoute, Outlet } = await import('@tanstack/react-router');
  const rootRoute = createRootRoute({
    component: function RootShell(): React.JSX.Element {
      return (
        <div data-testid="root-shell">
          <Outlet />
        </div>
      );
    },
  });
  const failingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/failing',
    component: function FailingPage(): React.JSX.Element {
      throw new Error('chunk failed to load');
    },
  });
  return { routeTree: rootRoute.addChildren([failingRoute]) };
});

describe('router error screen', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; silence the expected noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.history.pushState({}, '', '/failing');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.history.pushState({}, '', '/');
  });

  it('renders the app error screen inside the still-mounted root route when a route throws', async () => {
    const { router } = await import('./router');

    render(<RouterProvider router={router} />);

    const fallback = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="error-boundary-fallback"]');
      expect(element).not.toBeNull();
      return element;
    });
    expect(screen.getByTestId('root-shell')).toContainElement(fallback);
  });

  it('centres that error screen in a container filling the route', async () => {
    const { router } = await import('./router');

    render(<RouterProvider router={router} />);

    const fallback = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="error-boundary-fallback"]');
      expect(element).not.toBeNull();
      return element;
    });
    expect(fallback?.parentElement).toHaveClass(
      'flex',
      'min-h-full',
      'items-center',
      'justify-center'
    );
  });
});
