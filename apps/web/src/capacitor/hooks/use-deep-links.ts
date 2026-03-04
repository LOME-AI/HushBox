import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform.js';

/**
 * Listens for universal/app links opened from outside the app.
 *
 * Parses the full URL into a path (with query string) and delegates to the
 * provided callback, which should navigate via TanStack Router.
 * No-op on web.
 *
 * @param onDeepLink - Receives the URL path (e.g. `/chat/123` or `/billing?token=abc`)
 */
export function useDeepLinks(onDeepLink?: (path: string) => void): void {
  const callbackRef = useRef(onDeepLink);
  callbackRef.current = onDeepLink;

  useEffect(() => {
    if (!isNative()) return;

    const listener = App.addListener('appUrlOpen', ({ url }) => {
      const parsed = new URL(url);
      const path = parsed.pathname + parsed.search;
      callbackRef.current?.(path);
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);
}
