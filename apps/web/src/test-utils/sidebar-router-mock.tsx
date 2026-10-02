import * as React from 'react';
import { vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';

/**
 * The location `SidebarLinkMock` matches destinations against. A suite drives
 * it with `mockReturnValue` and, where the component under test also calls
 * `useLocation`, reads it back through {@link routerLocationMock} so one value
 * feeds both the router hook and the link's active mark.
 */
export const routerPathnameMock = vi.fn<() => string>(() => '/');

/** `useLocation`'s return shape, backed by {@link routerPathnameMock}. */
export function routerLocationMock(): { pathname: string } {
  return { pathname: routerPathnameMock() };
}

interface SidebarLinkMockProps {
  children: React.ReactNode;
  to: string;
  params?: { id: string };
  className?: string;
  onClick?: () => void;
  'aria-current'?: React.AriaAttributes['aria-current'];
}

/**
 * Stands in for `@tanstack/react-router`'s `Link` across the sidebar suites,
 * and is the single place the router's active-match semantics are written
 * down: the real `Link` resolves `$id` in `to` against `params`, then appends
 * `aria-current="page"` when that destination matches the current location and
 * passes a caller-supplied value through when it does not. Reproducing both
 * halves is what lets a suite read a row's mark as tracking the destination
 * its component builds while a caller-level `aria-current` stays visible.
 */
export function SidebarLinkMock({
  children,
  to,
  params,
  className,
  onClick,
  'aria-current': ariaCurrent,
}: Readonly<SidebarLinkMockProps>): React.JSX.Element {
  const href = params ? to.replace('$id', params.id) : to;
  return (
    <a
      href={href}
      className={className}
      data-testid={TEST_IDS.chatLink}
      onClick={onClick}
      aria-current={href === routerPathnameMock() ? 'page' : ariaCurrent}
    >
      {children}
    </a>
  );
}
