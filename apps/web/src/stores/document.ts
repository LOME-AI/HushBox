import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 400;

interface DocumentState {
  isPanelOpen: boolean;
  panelWidth: number;
  activeDocumentId: string | null;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setActiveDocument: (id: string) => void;
  setPanelWidth: (width: number) => void;
}

export const useDocumentStore = create<DocumentState>()(
  persist(
    (set) => ({
      isPanelOpen: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      activeDocumentId: null,

      openPanel: () => set({ isPanelOpen: true }),

      closePanel: () => set({ isPanelOpen: false, activeDocumentId: null }),

      togglePanel: () =>
        set((state) => ({
          isPanelOpen: !state.isPanelOpen,
          activeDocumentId: state.isPanelOpen ? null : state.activeDocumentId,
        })),

      setActiveDocument: (id) => set({ activeDocumentId: id, isPanelOpen: true }),

      setPanelWidth: (width) =>
        set({
          panelWidth: Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width)),
        }),
    }),
    {
      name: 'lome-document-storage',
      partialize: (state) => ({ panelWidth: state.panelWidth }),
    }
  )
);
