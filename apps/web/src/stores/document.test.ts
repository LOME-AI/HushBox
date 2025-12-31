import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from './document';

describe('useDocumentStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
    });
  });

  describe('initial state', () => {
    it('has panel closed by default', () => {
      const state = useDocumentStore.getState();
      expect(state.isPanelOpen).toBe(false);
    });

    it('has default panel width of 400', () => {
      const state = useDocumentStore.getState();
      expect(state.panelWidth).toBe(400);
    });

    it('has no active document by default', () => {
      const state = useDocumentStore.getState();
      expect(state.activeDocumentId).toBeNull();
    });
  });

  describe('openPanel', () => {
    it('opens the panel', () => {
      const { openPanel } = useDocumentStore.getState();
      openPanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('closePanel', () => {
    it('closes the panel', () => {
      useDocumentStore.setState({ isPanelOpen: true });
      const { closePanel } = useDocumentStore.getState();
      closePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('clears active document when closing', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      const { closePanel } = useDocumentStore.getState();
      closePanel();
      expect(useDocumentStore.getState().activeDocumentId).toBeNull();
    });
  });

  describe('togglePanel', () => {
    it('opens panel when closed', () => {
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });

    it('closes panel when open', () => {
      useDocumentStore.setState({ isPanelOpen: true });
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('clears active document when toggling closed', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-456' });
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().activeDocumentId).toBeNull();
    });
  });

  describe('setActiveDocument', () => {
    it('sets the active document ID', () => {
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument('doc-789');
      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-789');
    });

    it('opens the panel when setting active document', () => {
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument('doc-abc');
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });

    it('changes active document when panel is already open', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-old' });
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument('doc-new');
      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-new');
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('setPanelWidth', () => {
    it('sets the panel width', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(500);
      expect(useDocumentStore.getState().panelWidth).toBe(500);
    });

    it('enforces minimum width of 300', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(200);
      expect(useDocumentStore.getState().panelWidth).toBe(300);
    });

    it('enforces maximum width of 800', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(1000);
      expect(useDocumentStore.getState().panelWidth).toBe(800);
    });

    it('accepts values within range', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(600);
      expect(useDocumentStore.getState().panelWidth).toBe(600);
    });
  });
});
