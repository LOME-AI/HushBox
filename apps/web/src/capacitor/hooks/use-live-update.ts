import { useEffect } from 'react';
import { checkForUpdate, applyUpdate } from '../live-update.js';
import { useAppLifecycle } from './use-app-lifecycle.js';
import { isNative } from '../platform.js';

async function checkAndApply(): Promise<void> {
  const result = await checkForUpdate();
  if (result.updateAvailable && result.serverVersion) {
    await applyUpdate(result.serverVersion);
  }
}

/**
 * Checks for OTA updates on startup and when the app resumes from background.
 * If an update is available, downloads and applies it (destroys JS context).
 * No-op on web.
 */
export function useLiveUpdate(): void {
  useEffect(() => {
    if (!isNative()) return;
    void checkAndApply();
  }, []);

  useAppLifecycle({
    onResume: () => {
      void checkAndApply();
    },
  });
}
