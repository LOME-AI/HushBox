import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { WEB_SEARCH_STORAGE_KEY } from '@hushbox/shared';

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
      name: WEB_SEARCH_STORAGE_KEY,
    }
  )
);
