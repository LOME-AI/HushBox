import type { Platform } from '@hushbox/shared';
import { isPaymentDisabledPlatform } from '@hushbox/shared';

const platform: Platform = (import.meta.env['VITE_PLATFORM'] as Platform | undefined) ?? 'web';

/** Returns the build-time platform target. */
export function getPlatform(): Platform {
  return platform;
}

/** Returns true when running inside a Capacitor native shell (iOS or Android). */
export function isNative(): boolean {
  return platform !== 'web';
}

/** Returns true when in-app payment must be disabled (App Store / Play Store). */
export function isPaymentDisabled(): boolean {
  return isPaymentDisabledPlatform(platform);
}
