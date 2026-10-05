import { create } from 'zustand';
import type { Document } from '@/lib/chat/document-parser';

interface DocumentState {
  isPanelOpen: boolean;
  activeDocumentId: string | null;
  activeDocument: Document | null;
  /**
   * Increments once per explicit open. The document id is a content hash, so it
   * mutates as a message streams; this counter is what identifies one user
   * selection across those mutations.
   */
  activeSelectionId: number;
  isFullscreen: boolean;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  /** Opens a document the user picked — a new selection. */
  setActiveDocument: (document: Document) => void;
  /** Replaces the open document with a newer parse of the same selection. */
  refreshActiveDocument: (document: Document) => void;
  toggleFullscreen: () => void;
}

export const useDocumentStore = create<DocumentState>()((set) => ({
  isPanelOpen: false,
  activeDocumentId: null,
  activeDocument: null,
  activeSelectionId: 0,
  isFullscreen: false,

  openPanel: () => {
    set({ isPanelOpen: true });
  },

  closePanel: () => {
    set({
      isPanelOpen: false,
      activeDocumentId: null,
      activeDocument: null,
      isFullscreen: false,
    });
  },

  togglePanel: () => {
    set((state) => ({
      isPanelOpen: !state.isPanelOpen,
      ...(state.isPanelOpen ? { activeDocumentId: null, activeDocument: null } : {}),
    }));
  },

  setActiveDocument: (document) => {
    set((state) => ({
      activeDocumentId: document.id,
      activeDocument: document,
      activeSelectionId: state.activeSelectionId + 1,
      isPanelOpen: true,
    }));
  },

  refreshActiveDocument: (document) => {
    set({ activeDocumentId: document.id, activeDocument: document });
  },

  toggleFullscreen: () => {
    set((state) => ({ isFullscreen: !state.isFullscreen }));
  },
}));
