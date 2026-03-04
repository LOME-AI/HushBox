import { create } from 'zustand';

interface NetworkState {
  isOffline: boolean;
  setIsOffline: (offline: boolean) => void;
}

export const useNetworkStore = create<NetworkState>()((set) => ({
  isOffline: false,

  setIsOffline: (offline) => {
    set({ isOffline: offline });
  },
}));
