import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { RouteAnnouncer } from '@/components/shared/route-announcer';
import { renderWithProviders } from '@/test-utils/render';
import { Route as AuthRoute } from './_auth';
import { Route as LoginRoute } from './_auth/login';
import { Route as SignupRoute } from './_auth/signup';
import type { AnyRouter, RouteComponent } from '@tanstack/react-router';

vi.mock('@/lib/auth/auth', () => ({
  authClient: { resendVerification: vi.fn() },
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  resetPasswordViaRecovery: vi.fn(),
  verifyRecoveryPhrase: vi.fn(),
  discardVerifiedRecoveryPhrase: vi.fn(),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

// CipherWall draws on a canvas the DOM test environment does not provide.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (): React.JSX.Element => <div data-testid="cipher-wall" />,
  };
});

function componentOf(route: { options: { component?: RouteComponent } }): RouteComponent {
  const { component } = route.options;
  if (component === undefined) {
    throw new Error('route has no component');
  }
  return component;
}

/**
 * The real auth layout and pages under a root that mounts the real announcer
 * beside the outlet, as the app's root route does. The session guard is left
 * out: it only decides whether these routes render at all.
 */
function buildAuthRouter(initialPath: string): AnyRouter {
  const rootRoute = createRootRoute({
    component: (): React.JSX.Element => (
      <>
        <RouteAnnouncer />
        <Outlet />
      </>
    ),
  });
  const authLayout = createRoute({
    getParentRoute: () => rootRoute,
    id: '_auth',
    component: componentOf(AuthRoute),
  });
  const login = createRoute({
    getParentRoute: () => authLayout,
    path: 'login',
    component: componentOf(LoginRoute),
  });
  const signup = createRoute({
    getParentRoute: () => authLayout,
    path: 'signup',
    validateSearch: SignupRoute.options.validateSearch,
    component: componentOf(SignupRoute),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([authLayout.addChildren([login, signup])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe('client-side navigation between auth pages', () => {
  it('moves focus to the log in heading when the sign up page’s log in link is followed from the keyboard', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RouterProvider router={buildAuthRouter(ROUTES.SIGNUP)} />);

    const loginLink = await screen.findByRole('link', { name: 'Log in' });
    loginLink.focus();
    await user.keyboard('{Enter}');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });
});
