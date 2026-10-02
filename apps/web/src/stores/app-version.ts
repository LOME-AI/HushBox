import { create } from 'zustand';

/** Server-reported version details that may accompany raising Update Required. */
interface VersionMismatchDetails {
  currentVersion?: string | null;
  updateUrl?: string | null;
}

interface AppVersionState {
  upgradeRequired: boolean;
  // The server's current version and, on mobile platforms, its OTA download
  // URL, as a 426 VERSION_MISMATCH body reports them; the failed-chunk recovery
  // reports the version alone, from `GET /updates/current`. Null until either
  // reports; a bodyless/legacy 426 only flips `upgradeRequired`.
  currentVersion: string | null;
  updateUrl: string | null;
  setUpgradeRequired: (required: boolean, details?: VersionMismatchDetails) => void;
}

export const useAppVersionStore = create<AppVersionState>()((set) => ({
  upgradeRequired: false,
  currentVersion: null,
  updateUrl: null,

  setUpgradeRequired: (required, details) => {
    if (details === undefined) {
      set({ upgradeRequired: required });
      return;
    }
    set({
      upgradeRequired: required,
      currentVersion: details.currentVersion ?? null,
      updateUrl: details.updateUrl ?? null,
    });
  },
}));
