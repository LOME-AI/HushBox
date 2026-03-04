import { useEffect } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { isNative } from '../platform.js';

/**
 * Hides the native splash screen once the app has stabilized.
 *
 * The splash screen is configured with `launchAutoHide: false` so we
 * control exactly when it disappears — after StabilityProvider settles
 * (auth + balance queries loaded).
 */
export function useSplashScreen(isAppStable: boolean): void {
  useEffect(() => {
    if (!isNative()) return;
    if (!isAppStable) return;

    void SplashScreen.hide();
  }, [isAppStable]);
}
