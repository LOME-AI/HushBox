import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { isStaleClientVersion } from '@hushbox/shared';
import { getApiUrl } from '@/lib/api/api.js';
import { client, fetchJson } from '@/lib/api-client.js';
import { useAppVersionStore } from '@/stores/app-version.js';
import { isNative, getPlatform } from './platform.js';

interface CheckResult {
  updateAvailable: boolean;
  serverUpdate?: ServerUpdate;
}

/** `/updates/current` body: the served version plus the bundle's sha256. */
interface ServerUpdate {
  version: string;
  checksum: string | undefined;
}

/**
 * Fetches `/updates/current` ({ version, checksum? }). Returns null when the
 * lookup itself failed, which `checkForUpdate` reports as "no update available"
 * — the device stays on its current bundle until a later check answers.
 */
async function fetchServerUpdate(): Promise<ServerUpdate | null> {
  try {
    return await fetchJson(client.updates.current.$get());
  } catch (error: unknown) {
    console.error('Failed to fetch server version:', error);
    return null;
  }
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

/**
 * Downloads and applies the update `checkForUpdate` found. On success, the JS
 * context is destroyed and the app reloads with the new bundle. On failure,
 * sets the upgrade-required flag so the user sees the modal and can retry.
 *
 * Takes the already-fetched update rather than looking it up again: one check
 * feeds one apply, so there is no second lookup that can answer differently
 * from the one the caller acted on.
 */
export async function applyUpdate(serverUpdate: ServerUpdate): Promise<void> {
  if (!isNative()) {
    return;
  }

  const { version, checksum } = serverUpdate;
  // An OTA bundle is the app's own executable JS, running in the WebView that
  // holds the device key and plaintext, so a bundle whose bytes cannot be
  // verified is never installed — no carve-out for a deploy that published no
  // checksum. Refusing keeps the device on the bundle it is already running and
  // raises the same upgrade-required flag a download failure does, so the user
  // can retry against a later, correctly published deploy.
  if (checksum === undefined) {
    console.error('Refusing OTA update: the server published no bundle checksum');
    useAppVersionStore.getState().setUpgradeRequired(true);
    return;
  }

  try {
    const platform = getPlatform();
    // A 426 VERSION_MISMATCH stashes the server-supplied (relative) download
    // path; prefer it over the hand-built URL so the server stays the single
    // source of the OTA route. Fall back when no 426 populated the store.
    const serverUpdatePath = useAppVersionStore.getState().updateUrl;
    const url =
      serverUpdatePath === null
        ? `${getApiUrl()}/updates/download/${platform}/${version}`
        : `${getApiUrl()}${serverUpdatePath}`;
    // The server-published sha256 lets Capgo verify the downloaded bytes and
    // reject a tampered/corrupt bundle before it is ever applied.
    const bundle = await CapacitorUpdater.download({ url, version, checksum });

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
 * Returns whether an update is available and, when it is, the fetched update
 * for `applyUpdate` to install.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!isNative()) {
    return { updateAvailable: false };
  }

  // Notify Capgo that the current bundle booted successfully
  await CapacitorUpdater.notifyAppReady();

  const [appVersion, serverUpdate] = await Promise.all([getAppVersion(), fetchServerUpdate()]);

  // Can't check if server unreachable
  if (!serverUpdate?.version) {
    return { updateAvailable: false };
  }

  // Any divergence from a versioned deployment, a server version *lower* than
  // the installed bundle included, is treated as an update to apply. There is
  // deliberately no downgrade guard: a lower APP_VERSION is an intentional
  // rollback lever (ship the previous bundle to recall a bad release), and
  // honoring it is an accepted, ruled behavior, not an oversight.
  if (isStaleClientVersion(appVersion, serverUpdate.version)) {
    return { updateAvailable: true, serverUpdate };
  }

  return { updateAvailable: false };
}
