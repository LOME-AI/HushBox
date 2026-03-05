import { useEffect } from 'react';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isNative, getPlatform } from '../platform.js';

/**
 * Syncs the native status bar appearance with the current theme.
 *
 * iOS: sets content style only (background is transparent via viewport-fit=cover).
 * Android: sets both content style and background color.
 * Web: no-op.
 */
export function useStatusBar(mode: 'light' | 'dark'): void {
  useEffect(() => {
    if (!isNative()) return;

    const style = mode === 'dark' ? Style.Dark : Style.Light;
    void StatusBar.setStyle({ style });

    const platform = getPlatform();
    if (platform === 'android' || platform === 'android-direct') {
      // Brand background colors from packages/config/tailwind/index.css
      const color = mode === 'dark' ? '#1a1816' : '#faf9f6';
      void StatusBar.setBackgroundColor({ color });
    }
  }, [mode]);
}
