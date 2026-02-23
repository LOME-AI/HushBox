import * as React from 'react';

const TOUCH_QUERY = '(pointer: coarse)';

/**
 * Hook to detect if the primary pointer is coarse (touch device).
 * Uses `(pointer: coarse)` media query — more accurate than viewport width
 * for detecting "can't hover" devices (phones, tablets).
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = React.useState(() => {
    if (!('window' in globalThis)) return false;
    return globalThis.matchMedia(TOUCH_QUERY).matches;
  });

  React.useEffect(() => {
    const mediaQuery = globalThis.matchMedia(TOUCH_QUERY);
    const handler = (e: MediaQueryListEvent): void => {
      setIsTouch(e.matches);
    };

    setIsTouch(mediaQuery.matches);
    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  return isTouch;
}
