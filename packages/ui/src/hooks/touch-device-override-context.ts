'use client';

import * as React from 'react';

/**
 * Context to override touch device detection for dev testing.
 * - `null` = no override, use real media query
 * - `true` = force touch device (shows bottom sheets)
 * - `false` = force non-touch (shows centered dialogs)
 */
const TouchDeviceOverrideContext = React.createContext<boolean | null>(null);

function useTouchDeviceOverride(): boolean | null {
  return React.useContext(TouchDeviceOverrideContext);
}

export { TouchDeviceOverrideContext, useTouchDeviceOverride };
