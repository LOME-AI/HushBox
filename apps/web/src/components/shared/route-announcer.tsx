import * as React from 'react';
import { useRouter } from '@tanstack/react-router';

/**
 * True when the destination route deliberately focused a form control inside the
 * main region (e.g. the new-chat composer autofocus). The announcer must not
 * steal that focus; the live region still announces the navigation.
 */
function pageManagesFocus(main: HTMLElement | null): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    main !== null &&
    main.contains(active) &&
    active.matches('input, textarea, select, [contenteditable="true"]')
  );
}

/**
 * Manages focus and screen-reader announcements on client-side navigation.
 *
 * TanStack Router swaps `<Outlet>` content without moving DOM focus, so without
 * this, keyboard focus stays on the (often unmounted) clicked link and SR users
 * get no cue that the page changed. On each resolved navigation we move focus to
 * the new route's main heading (falling back to the `#main` region) and push the
 * destination into a polite live region.
 */
export function RouteAnnouncer(): React.JSX.Element {
  const router = useRouter();
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    return router.subscribe('onResolved', (event) => {
      const main = document.querySelector<HTMLElement>('#main');
      const heading = main?.querySelector('h1');
      const target = heading ?? main;
      // Headings aren't focusable by default; make the chosen heading
      // programmatically focusable so SR users land on (and hear) it.
      if (heading && !heading.hasAttribute('tabindex')) {
        heading.setAttribute('tabindex', '-1');
      }
      // Yield to a control the destination route deliberately focused (e.g. the
      // new-chat composer autofocus) rather than stealing it back to the heading.
      if (!pageManagesFocus(main)) {
        target?.focus();
      }

      setMessage(`Navigated to ${event.toLocation.pathname}`);
    });
  }, [router]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
