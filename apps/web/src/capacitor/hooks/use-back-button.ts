import { useEffect } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform.js';

/**
 * Handles the Android hardware back button.
 *
 * If the WebView has history to go back to, navigates back.
 * Otherwise, exits the app (standard Android behavior).
 * No-op on web and iOS.
 */
export function useBackButton(): void {
  useEffect(() => {
    if (!isNative()) return;

    const listener = App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        globalThis.history.back();
      } else {
        void App.exitApp();
      }
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);
}
