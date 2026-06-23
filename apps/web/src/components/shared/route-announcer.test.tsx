import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

type ResolvedListener = (event: { toLocation: { pathname: string } }) => void;

const subscribe = vi.fn<(eventType: string, function_: ResolvedListener) => () => void>();
const unsubscribe = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ subscribe }),
}));

import { RouteAnnouncer } from './route-announcer';

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
      onResolved({ toLocation: { pathname: '/settings' } });
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
      onResolved({ toLocation: { pathname: '/settings' } });
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
      onResolved({ toLocation: { pathname: '/chat' } });
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
      onResolved({ toLocation: { pathname: '/chat' } });
    });

    expect(document.activeElement).toBe(main);
  });
});
