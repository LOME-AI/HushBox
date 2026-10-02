import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useUIStore } from '@/stores/ui/ui';
import { useUIModalsStore } from '@/stores/ui/modals';
import type { AppActionContext } from '@/lib/app-actions';

/** The one context every surface runs an app action with: the account menu, the palette, the shortcuts. */
export function useAppActionContext(): AppActionContext {
  const navigate = useNavigate();
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);
  const setFeedbackOpen = useUIModalsStore((state) => state.setFeedbackOpen);
  return React.useMemo(
    () => ({
      navigate,
      closeDrawer: () => {
        setMobileSidebarOpen(false);
      },
      openFeedback: () => {
        setFeedbackOpen(true);
      },
    }),
    [navigate, setMobileSidebarOpen, setFeedbackOpen]
  );
}
