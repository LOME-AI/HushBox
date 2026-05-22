import * as React from 'react';

/**
 * Subscribe to a CSS media query and re-render when its match state changes.
 * SSR-safe: returns false on the server, then updates on hydration.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(() => {
    if (!('window' in globalThis)) return false;
    return globalThis.matchMedia(query).matches;
  });

  React.useEffect(() => {
    if (!('window' in globalThis)) return;
    const mediaQuery = globalThis.matchMedia(query);
    setMatches(mediaQuery.matches);
    const handler = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, [query]);

  return matches;
}
