import { create } from 'zustand';

interface AppVersionState {
  upgradeRequired: boolean;
  setUpgradeRequired: (required: boolean) => void;
}

export const useAppVersionStore = create<AppVersionState>()((set) => ({
  upgradeRequired: false,

  setUpgradeRequired: (required) => {
    set({ upgradeRequired: required });
  },
}));
