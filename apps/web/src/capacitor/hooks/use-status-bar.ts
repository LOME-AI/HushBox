import { useEffect } from 'react';
import { StatusBar, Style } from '@capacitor/status-bar';
import { readThemeColor } from '@hushbox/ui/cipher-wall/hook';
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
      // Reads the theme class ThemeProvider puts on the document root, which it
      // applies in an effect declared above its useStatusBar call — so the class
      // already matches `mode` by the time this runs.
      void StatusBar.setBackgroundColor({ color: readThemeColor('--background') });
    }
  }, [mode]);
}
