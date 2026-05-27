import { useEffect } from 'react';
import { useAppVersionStore } from '@/stores/app-version.js';
import { checkForUpdate, applyUpdate } from '../live-update.js';
import { useAppLifecycle } from './use-app-lifecycle.js';
import { isNative } from '../platform.js';

async function checkAndApply(): Promise<void> {
  // Flag the OTA window so the upgrade-required modal stays hidden while a
  // version-mismatch 426 is expected. On a successful apply the JS context is
  // destroyed mid-call (the finally never runs, and the reloaded bundle starts
  // with the flag false); on no-update or a failed apply, finally clears it so
  // a genuine upgrade-required state can still surface the modal.
  const { setOtaInProgress } = useAppVersionStore.getState();
  setOtaInProgress(true);
  try {
    const result = await checkForUpdate();
    if (result.updateAvailable && result.serverVersion) {
      await applyUpdate(result.serverVersion);
    }
  } finally {
    setOtaInProgress(false);
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
