import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';

type ResolvedListener = (event: {
  fromLocation?: { pathname: string };
  toLocation: { pathname: string };
}) => void;

const subscribe = vi.fn<(eventType: string, function_: ResolvedListener) => () => void>();
const unsubscribe = vi.fn();

// The announcer's `useRouter` returns this: the stub below by default, or a real
// router where a test needs the router's own events.
let routerUnderTest: Pick<AnyRouter, 'subscribe'> | { subscribe: typeof subscribe } = {
  subscribe,
};

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => routerUnderTest,
}));

import { RouteAnnouncer } from './route-announcer';
import type { AnyRouter } from '@tanstack/react-router';

const PREVIOUS_LOCATION = { pathname: '/previous' };

function PageWithHeading({
  title,
  linkTo,
}: Readonly<{ title: string; linkTo?: string }>): React.JSX.Element {
  return (
    <main id="main" tabIndex={-1}>
      <h1>{title}</h1>
      {linkTo !== undefined && <Link to={linkTo}>Next page</Link>}
    </main>
  );
}

/** Two pages under a root that mounts the announcer beside the outlet, as the app's root route does. */
function buildRouter(): AnyRouter {
  const rootRoute = createRootRoute({
    component: (): React.JSX.Element => (
      <>
        <RouteAnnouncer />
        <Outlet />
      </>
    ),
  });
  const first = createRoute({
    getParentRoute: () => rootRoute,
    path: 'first',
    component: (): React.JSX.Element => <PageWithHeading title="First page" linkTo="/second" />,
  });
  const second = createRoute({
    getParentRoute: () => rootRoute,
    path: 'second',
    component: (): React.JSX.Element => <PageWithHeading title="Second page" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([first, second]),
    history: createMemoryHistory({ initialEntries: ['/first'] }),
  });
}

/** Renders the app's first load and waits until the router has resolved it. */
async function renderFirstLoad(): Promise<void> {
  const router = buildRouter();
  routerUnderTest = router;
  const resolved = vi.fn();
  router.subscribe('onResolved', resolved);
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { level: 1, name: 'First page' });
  await waitFor(() => {
    expect(resolved).toHaveBeenCalledTimes(1);
  });
}

function captureResolvedListener(): ResolvedListener {
  const call = subscribe.mock.calls.find(([eventType]) => eventType === 'onResolved');
  if (call === undefined) {
    throw new Error('RouteAnnouncer did not subscribe to onResolved');
  }
  return call[1];
}

describe('RouteAnnouncer', () => {
  beforeEach(() => {
    subscribe.mockReset();
    unsubscribe.mockReset();
    subscribe.mockReturnValue(unsubscribe);
    routerUnderTest = { subscribe };
    document.body.innerHTML = '';
  });

  it('renders a polite live region', () => {
    render(<RouteAnnouncer />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('subscribes to onResolved router events', () => {
    render(<RouteAnnouncer />);
    expect(subscribe).toHaveBeenCalledWith('onResolved', expect.any(Function));
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<RouteAnnouncer />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('announces the new route when navigation resolves', () => {
    render(<RouteAnnouncer />);
    const onResolved = captureResolvedListener();

    act(() => {
      onResolved({ fromLocation: PREVIOUS_LOCATION, toLocation: { pathname: '/settings' } });
    });

    expect(screen.getByRole('status')).toHaveTextContent('/settings');
  });

  it('moves focus to the main region heading when navigation resolves', () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    main.append(heading);
    document.body.append(main);

    render(<RouteAnnouncer />);
    const onResolved = captureResolvedListener();

    act(() => {
      onResolved({ fromLocation: PREVIOUS_LOCATION, toLocation: { pathname: '/settings' } });
    });

    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(heading);
  });

  it('does not steal focus from a control the page focused inside the main region', () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    const heading = document.createElement('h1');
    heading.textContent = 'New chat';
    const input = document.createElement('textarea');
    main.append(heading, input);
    document.body.append(main);
    input.focus();
    expect(document.activeElement).toBe(input);

    render(<RouteAnnouncer />);
    const onResolved = captureResolvedListener();

    act(() => {
      onResolved({ fromLocation: PREVIOUS_LOCATION, toLocation: { pathname: '/chat' } });
    });

    // The page's deliberate autofocus wins; the announcement still fires.
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('status')).toHaveTextContent('/chat');
  });

  it('falls back to focusing main when there is no heading', () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);

    render(<RouteAnnouncer />);
    const onResolved = captureResolvedListener();

    act(() => {
      onResolved({ fromLocation: PREVIOUS_LOCATION, toLocation: { pathname: '/chat' } });
    });

    expect(document.activeElement).toBe(main);
  });

  describe('when the page replaces the heading it focused', () => {
    function mainWithHeading(title: string): { main: HTMLElement; heading: HTMLElement } {
      const main = document.createElement('main');
      main.id = 'main';
      main.tabIndex = -1;
      const heading = document.createElement('h1');
      heading.textContent = title;
      main.append(heading);
      document.body.append(main);
      return { main, heading };
    }

    function resolveNavigation(pathname: string): void {
      const onResolved = captureResolvedListener();
      act(() => {
        onResolved({ fromLocation: PREVIOUS_LOCATION, toLocation: { pathname } });
      });
    }

    it('focuses the heading that replaced it', async () => {
      const { main, heading } = mainWithHeading('Decrypting...');
      render(<RouteAnnouncer />);
      resolveNavigation('/chat/c1');
      expect(document.activeElement).toBe(heading);

      const replacement = document.createElement('h1');
      replacement.textContent = 'Lisbon trip planning';
      heading.replaceWith(replacement);

      await waitFor(() => {
        expect(document.activeElement).toBe(replacement);
      });
      expect(replacement).toHaveAttribute('tabindex', '-1');
      expect(main).toContainElement(replacement);
    });

    it('focuses the main region when no heading replaced it', async () => {
      const { main, heading } = mainWithHeading('Decrypting...');
      render(<RouteAnnouncer />);
      resolveNavigation('/chat/c1');

      heading.remove();

      await waitFor(() => {
        expect(document.activeElement).toBe(main);
      });
    });

    it('follows a second replacement of the heading', async () => {
      const { heading } = mainWithHeading('Decrypting...');
      render(<RouteAnnouncer />);
      resolveNavigation('/chat/c1');
      const second = document.createElement('h1');
      second.textContent = 'Decrypting...';
      heading.replaceWith(second);
      await waitFor(() => {
        expect(document.activeElement).toBe(second);
      });

      const third = document.createElement('h1');
      third.textContent = 'Lisbon trip planning';
      second.replaceWith(third);

      await waitFor(() => {
        expect(document.activeElement).toBe(third);
      });
    });

    it('leaves focus where the reader moved it before the heading went', async () => {
      const { main, heading } = mainWithHeading('Decrypting...');
      const button = document.createElement('button');
      main.append(button);
      render(<RouteAnnouncer />);
      resolveNavigation('/chat/c1');

      button.focus();
      const replacement = document.createElement('h1');
      heading.replaceWith(replacement);
      await act(async () => {
        await Promise.resolve();
      });

      expect(document.activeElement).toBe(button);
    });

    it('stops watching once a newer navigation resolves', async () => {
      const { main, heading } = mainWithHeading('Settings');
      const input = document.createElement('input');
      main.append(input);
      render(<RouteAnnouncer />);
      resolveNavigation('/settings');
      // The next page focuses its own control, so that navigation starts no watch of its own.
      input.focus();
      resolveNavigation('/chat');

      input.remove();
      heading.remove();
      await act(async () => {
        await Promise.resolve();
      });

      expect(document.activeElement).toBe(document.body);
    });

    it('stops watching when it unmounts', async () => {
      const { heading } = mainWithHeading('Decrypting...');
      const { unmount } = render(<RouteAnnouncer />);
      resolveNavigation('/chat/c1');
      unmount();

      heading.replaceWith(document.createElement('h1'));
      await act(async () => {
        await Promise.resolve();
      });

      expect(document.activeElement).toBe(document.body);
    });
  });

  describe('with the app router', () => {
    it('moves no focus on the first load', async () => {
      await renderFirstLoad();

      expect(document.activeElement).toBe(document.body);
    });

    it('announces nothing on the first load', async () => {
      await renderFirstLoad();

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('focuses the destination heading on a client-side navigation after the first load', async () => {
      await renderFirstLoad();
      const user = userEvent.setup();

      await user.click(screen.getByRole('link', { name: 'Next page' }));

      const heading = await screen.findByRole('heading', { level: 1, name: 'Second page' });
      await waitFor(() => {
        expect(document.activeElement).toBe(heading);
      });
    });

    it('announces a client-side navigation after the first load', async () => {
      await renderFirstLoad();
      const user = userEvent.setup();

      await user.click(screen.getByRole('link', { name: 'Next page' }));

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Navigated to /second');
      });
    });
  });
});
