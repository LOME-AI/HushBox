import { create } from 'zustand';

interface AppVersionState {
  upgradeRequired: boolean;
  setUpgradeRequired: (required: boolean) => void;
  // True while the live-update flow is checking for / applying an OTA bundle.
  // Suppresses the upgrade-required modal during the version-mismatch window so
  // a transient 426 doesn't flash the modal before Capgo's silent reload lands.
  otaInProgress: boolean;
  setOtaInProgress: (inProgress: boolean) => void;
}

export const useAppVersionStore = create<AppVersionState>()((set) => ({
  upgradeRequired: false,

  setUpgradeRequired: (required) => {
    set({ upgradeRequired: required });
  },

  otaInProgress: false,

  setOtaInProgress: (inProgress) => {
    set({ otaInProgress: inProgress });
  },
}));
