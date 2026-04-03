import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { isNative, getPlatform } from './platform.js';
import { getApiUrl } from '@/lib/api.js';
import { useAppVersionStore } from '@/stores/app-version.js';

interface CheckResult {
  updateAvailable: boolean;
  serverVersion?: string;
}

/** Returns the current app version — bundle version on native, "web" on browser. */
export async function getAppVersion(): Promise<string> {
  if (!isNative()) {
    return 'web';
  }

  const { bundle, native } = await CapacitorUpdater.current();
  const version = bundle.version;

  // "builtin" or empty means no OTA bundle applied — use native shell version
  if (!version || version === 'builtin') {
    return native;
  }

  return version;
}

/** Fetches the current server version. Returns null on failure. */
export async function getServerVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${getApiUrl()}/api/updates/current`);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch (error: unknown) {
    console.error('Failed to fetch server version:', error);
    return null;
  }
}

/**
 * Downloads and applies an OTA update. On success, the JS context is destroyed
 * and the app reloads with the new bundle. On failure, sets the upgrade-required
 * flag so the user sees the modal.
 */
export async function applyUpdate(version: string): Promise<void> {
  if (!isNative()) {
    return;
  }

  try {
    const platform = getPlatform();
    const bundle = await CapacitorUpdater.download({
      url: `${getApiUrl()}/api/updates/download/${platform}/${version}`,
      version,
    });

    // set() destroys JS context — no code runs after this
    await CapacitorUpdater.set({ id: bundle.id });
  } catch (error: unknown) {
    console.error('Failed to apply OTA update:', error);
    // Download or apply failed — show upgrade modal as fallback
    useAppVersionStore.getState().setUpgradeRequired(true);
  }
}

/**
 * Checks whether an OTA update is available. Calls `notifyAppReady()` to
 * confirm the current bundle is healthy (prevents Capgo auto-rollback).
 * Returns whether an update is available and the target version.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!isNative()) {
    return { updateAvailable: false };
  }

  // Notify Capgo that the current bundle booted successfully
  await CapacitorUpdater.notifyAppReady();

  const [appVersion, serverVersion] = await Promise.all([getAppVersion(), getServerVersion()]);

  // Can't check if server unreachable
  if (!serverVersion) {
    return { updateAvailable: false };
  }

  // Skip comparison in dev
  if (serverVersion === 'dev-local') {
    return { updateAvailable: false };
  }

  if (appVersion !== serverVersion) {
    return { updateAvailable: true, serverVersion };
  }

  return { updateAvailable: false };
}
