import { isStaleClientVersion } from '@hushbox/shared';
import { appVersion, client, fetchJson } from '@/lib/api-client.js';
import { useAppVersionStore } from '@/stores/app-version.js';

async function raiseUpdateRequiredIfStale(): Promise<void> {
  let servedVersion: string;
  try {
    ({ version: servedVersion } = await fetchJson(client.updates.current.$get()));
  } catch {
    // Unanswered, the tab cannot tell a newer deployment from a network blip,
    // so the failed import's own error screen is left to speak for it.
    return;
  }
  if (isStaleClientVersion(appVersion, servedVersion)) {
    useAppVersionStore.getState().setUpgradeRequired(true, { currentVersion: servedVersion });
  }
}

/**
 * A lazily loaded chunk fails when the deployment that built this tab is gone
 * (its hashed assets no longer served), and Vite reports every such failure as
 * `vite:preloadError`. The listener asks which version is live and raises the
 * Update Required modal when that version is a versioned one and this tab runs
 * any other. It never calls `preventDefault()`, so the import still rejects and
 * the route's error screen still shows.
 */
export function installChunkLoadRecovery(): void {
  globalThis.addEventListener('vite:preloadError', () => {
    void raiseUpdateRequiredIfStale();
  });
}
