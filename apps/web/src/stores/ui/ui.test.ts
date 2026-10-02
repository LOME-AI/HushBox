import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useUIStore } from './ui';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false, mobileSidebarOpen: false });
  });

  describe('initial state', () => {
    it('opens the desktop sidebar on a first visit', () => {
      expect(useUIStore.getInitialState().sidebarOpen).toBe(true);
    });

    it('has mobile sidebar closed by default', () => {
      const state = useUIStore.getState();
      expect(state.mobileSidebarOpen).toBe(false);
    });
  });

  describe('setSidebarOpen', () => {
    it('sets sidebar to closed when passed false', () => {
      const { setSidebarOpen } = useUIStore.getState();
      setSidebarOpen(false);
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('sets sidebar to open when passed true', () => {
      useUIStore.setState({ sidebarOpen: false });
      const { setSidebarOpen } = useUIStore.getState();
      setSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('toggleSidebar', () => {
    it('toggles sidebar from closed to open', () => {
      const { toggleSidebar } = useUIStore.getState();
      toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('toggles sidebar from open to closed', () => {
      useUIStore.setState({ sidebarOpen: true });
      const { toggleSidebar } = useUIStore.getState();
      toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });
  });

  describe('the saved sidebar choice', () => {
    const STORAGE_KEY = 'hushbox-ui-storage';

    afterEach(() => {
      vi.mocked(localStorage.getItem).mockReset().mockReturnValue(null);
      vi.mocked(localStorage.setItem).mockClear();
    });

    it('restores a collapsed sidebar the user chose on an earlier visit', async () => {
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === STORAGE_KEY ? JSON.stringify({ state: { sidebarOpen: false }, version: 0 }) : null
      );
      useUIStore.setState({ sidebarOpen: true });

      await useUIStore.persist.rehydrate();

      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('keeps the first-visit default when nothing was saved', async () => {
      useUIStore.setState(useUIStore.getInitialState());

      await useUIStore.persist.rehydrate();

      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('saves the choice the user makes', () => {
      useUIStore.getState().setSidebarOpen(false);

      const call = vi
        .mocked(localStorage.setItem)
        .mock.calls.findLast(([key]) => key === STORAGE_KEY);
      const saved = JSON.parse(call?.[1] ?? '{}') as { state?: { sidebarOpen?: boolean } };
      expect(saved.state?.sidebarOpen).toBe(false);
    });
  });

  describe('setMobileSidebarOpen', () => {
    it('opens mobile sidebar when passed true', () => {
      const { setMobileSidebarOpen } = useUIStore.getState();
      setMobileSidebarOpen(true);
      expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
    });

    it('closes mobile sidebar when passed false', () => {
      useUIStore.setState({ mobileSidebarOpen: true });
      const { setMobileSidebarOpen } = useUIStore.getState();
      setMobileSidebarOpen(false);
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('forces sidebarOpen to true when opening mobile sidebar', () => {
      useUIStore.setState({ sidebarOpen: false, mobileSidebarOpen: false });
      const { setMobileSidebarOpen } = useUIStore.getState();
      setMobileSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('does not change sidebarOpen when closing mobile sidebar', () => {
      useUIStore.setState({ sidebarOpen: false, mobileSidebarOpen: true });
      const { setMobileSidebarOpen } = useUIStore.getState();
      setMobileSidebarOpen(false);
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });
  });
});
