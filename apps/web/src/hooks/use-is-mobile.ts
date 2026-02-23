import * as React from 'react';
import { MOBILE_BREAKPOINT } from '@hushbox/shared';

/**
 * Hook to detect if viewport is mobile (<768px).
 * Matches sidebar's Tailwind `md:` breakpoint for consistency.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (!('window' in globalThis)) return false;
    return globalThis.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`).matches;
  });

  React.useEffect(() => {
    const mediaQuery = globalThis.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`);
    const handler = (e: MediaQueryListEvent): void => {
      setIsMobile(e.matches);
    };

    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  return isMobile;
}
