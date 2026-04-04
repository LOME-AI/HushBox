import * as React from 'react';

import { TOUCH_QUERY } from '@hushbox/shared';

import { useTouchDeviceOverride } from './touch-device-override-context';

export { TOUCH_QUERY } from '@hushbox/shared';

/**
 * Hook to detect if the primary pointer is coarse (touch device).
 * Uses `(pointer: coarse)` media query — more accurate than viewport width
 * for detecting "can't hover" devices (phones, tablets).
 *
 * Checks TouchDeviceOverrideContext first — if non-null, returns the override.
 * This enables dev-mode testing of touch behavior on desktop.
 */
export function useIsTouchDevice(): boolean {
  const override = useTouchDeviceOverride();

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

  if (override !== null) return override;
  return isTouch;
}
