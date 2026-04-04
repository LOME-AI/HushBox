import { useEffect } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { isNative } from '../platform.js';
import { useAppVersionStore } from '@/stores/app-version.js';

/**
 * Hides the native splash screen once the app has stabilized or an upgrade
 * is required.
 *
 * The splash screen is configured with `launchAutoHide: false` so we
 * control exactly when it disappears — after StabilityProvider settles
 * (auth + balance queries loaded) OR when the server returns 426 and the
 * upgrade modal needs to be visible.
 */
export function useSplashScreen(isAppStable: boolean): void {
  const upgradeRequired = useAppVersionStore((s) => s.upgradeRequired);

  useEffect(() => {
    if (!isNative()) return;
    if (!isAppStable && !upgradeRequired) return;

    void SplashScreen.hide();
  }, [isAppStable, upgradeRequired]);
}
