import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SearchState {
  webSearchEnabled: boolean;
  toggleWebSearch: () => void;
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      webSearchEnabled: false,
      toggleWebSearch: () => set((state) => ({ webSearchEnabled: !state.webSearchEnabled })),
    }),
    {
      name: 'hushbox-search-storage',
    }
  )
);
