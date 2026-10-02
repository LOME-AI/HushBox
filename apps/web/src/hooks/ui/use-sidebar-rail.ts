import { useFormFactor } from '@hushbox/ui/platform';
import { useOpenPaneDocks } from '@/components/shared/right-pane';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIStore } from '@/stores/ui/ui';

/**
 * Whether the sidebar shows its rail. It is the rail off the phone band when the saved
 * choice is the rail or a right pane is docked; the pane folds it without touching the
 * saved choice, so closing the pane brings back whatever the user last chose. A pane that
 * takes its sheet form, because the window cannot hold it beside the thread, leaves the
 * sidebar as it was; until the open pane has decided, it counts as docked. Every part of
 * the sidebar that draws a rail form reads this, never the saved flag.
 */
export function useSidebarRail(): boolean {
  const isPhone = useFormFactor().band === 'phone';
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const paneOpen = useRightPane((state) => state.active !== null);
  const paneDocks = useOpenPaneDocks();
  const paneDocked = paneOpen && paneDocks !== false;
  return !isPhone && (!sidebarOpen || paneDocked);
}

/**
 * Opens the sidebar from its rail. Over a docked pane the pane closes, giving its room
 * back, rather than the sidebar opening under a fold that would keep it a rail.
 */
export function useExpandSidebar(): () => void {
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
  const closePane = useRightPane((state) => state.close);
  return (): void => {
    closePane();
    setSidebarOpen(true);
  };
}
