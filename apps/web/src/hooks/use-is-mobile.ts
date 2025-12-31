import * as React from 'react';

const MOBILE_BREAKPOINT = 768; // Tailwind md: breakpoint

/**
 * Hook to detect if viewport is mobile (<768px).
 * Matches sidebar's Tailwind `md:` breakpoint for consistency.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`).matches;
  });

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`);
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
