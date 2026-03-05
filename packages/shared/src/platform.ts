/**
 * Platform detection utilities.
 *
 * Pure functions with no Capacitor dependency — safe to import on both
 * frontend and backend.  The frontend Capacitor-specific utilities
 * (getPlatform, isNative) live in apps/web/src/capacitor/platform.ts.
 */

/** All valid platform targets, used for runtime validation and type derivation. */
export const VALID_PLATFORMS = ['web', 'ios', 'android', 'android-direct'] as const;

/** Build-time platform target set via VITE_PLATFORM / X-HushBox-Platform header. */
export type Platform = (typeof VALID_PLATFORMS)[number];

/**
 * Returns true when in-app payment must be disabled (App Store / Play Store builds).
 *
 * `android-direct` (Obtainium / GitHub Release APK) keeps payments enabled
 * because there is no store intermediary.
 */
export function isPaymentDisabledPlatform(platform: Platform): boolean {
  return platform === 'ios' || platform === 'android';
}
