import * as React from 'react';
import { useRouter } from '@tanstack/react-router';

/**
 * True when the destination route deliberately focused a form control inside the
 * main region (e.g. the new-chat composer autofocus). The announcer must not
 * steal that focus; the live region still announces the navigation.
 */
function pageManagesFocus(main: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    main.contains(active) &&
    active.matches('input, textarea, select, [contenteditable="true"]')
  );
}

/**
 * Focuses the main region's first heading, or the region itself when it has none, and
 * returns what it focused. Headings aren't focusable by default; the chosen heading is
 * made programmatically focusable so SR users land on (and hear) it.
 */
function focusMainTarget(main: HTMLElement): HTMLElement {
  const heading = main.querySelector('h1');
  if (heading !== null && !heading.hasAttribute('tabindex')) {
    heading.setAttribute('tabindex', '-1');
  }
  const target = heading ?? main;
  target.focus();
  return target;
}

/**
 * Manages focus and screen-reader announcements on client-side navigation.
 *
 * TanStack Router swaps `<Outlet>` content without moving DOM focus, so without
 * this, keyboard focus stays on the (often unmounted) clicked link and SR users
 * get no cue that the page changed. On each resolved client-side navigation we move
 * focus to the new route's main heading (falling back to the `#main` region) and push
 * the destination into a polite live region.
 */
export function RouteAnnouncer(): React.JSX.Element {
  const router = useRouter();
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    let watcher: MutationObserver | undefined;
    const stopWatching = (): void => {
      watcher?.disconnect();
      watcher = undefined;
    };

    const unsubscribe = router.subscribe('onResolved', (event) => {
      stopWatching();
      // The app's first load resolves with no previous location and strands no focus; moving
      // focus there would draw a keyboard-visible ring and start the first Tab past the skip link.
      if (event.fromLocation === undefined) {
        return;
      }
      const main = document.querySelector<HTMLElement>('#main');
      // Yield to a control the destination route deliberately focused (e.g. the
      // new-chat composer autofocus) rather than stealing it back to the heading.
      if (main !== null && !pageManagesFocus(main)) {
        let focused = focusMainTarget(main);
        // A page can swap the heading just focused for another as it finishes loading (the
        // conversation page does); focus then falls to the body, so it follows the swap
        // until the next navigation.
        watcher = new MutationObserver(() => {
          if (focused.isConnected) return;
          if (document.activeElement !== document.body || !main.isConnected) {
            stopWatching();
            return;
          }
          focused = focusMainTarget(main);
        });
        watcher.observe(main, { childList: true, subtree: true });
      }

      setMessage(`Navigated to ${event.toLocation.pathname}`);
    });

    return (): void => {
      stopWatching();
      unsubscribe();
    };
  }, [router]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
