import * as React from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Hook to detect if the user prefers reduced motion via the
 * `prefers-reduced-motion: reduce` media query.
 *
 * SSR-safe — returns `false` when `window` is undefined. Subscribes to
 * `MediaQueryList` change events so it reflects mid-session OS preference
 * changes. Listener is cleaned up on unmount.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = React.useState(() => {
    if (!('window' in globalThis)) return false;
    return globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  React.useEffect(() => {
    if (!('window' in globalThis)) return;
    const mediaQuery = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    const handler = (e: MediaQueryListEvent): void => {
      setReducedMotion(e.matches);
    };

    setReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  return reducedMotion;
}
