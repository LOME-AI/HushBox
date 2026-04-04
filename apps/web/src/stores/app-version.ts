import { create } from 'zustand';

interface AppVersionState {
  upgradeRequired: boolean;
  updateInProgress: boolean;
  setUpgradeRequired: (required: boolean) => void;
  setUpdateInProgress: (inProgress: boolean) => void;
}

export const useAppVersionStore = create<AppVersionState>()((set) => ({
  upgradeRequired: false,
  updateInProgress: false,

  setUpgradeRequired: (required) => {
    set({ upgradeRequired: required });
  },

  setUpdateInProgress: (inProgress) => {
    set({ updateInProgress: inProgress });
  },
}));
