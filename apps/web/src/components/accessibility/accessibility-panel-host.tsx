import * as React from 'react';
import { RightPane } from '@/components/shared/right-pane';
import { useAccessibilityPanelStore } from '@/stores/ui/accessibility-panel';
import { useRightPane } from '@/stores/ui/right-pane';

const PANE_ID = 'accessibility';

// The panel's subpath carries the on-device speech engine, so it loads with the first
// opening rather than with every page the shell draws.
const AccessibilityPanel = React.lazy(async () => {
  const m = await import('@hushbox/ui/accessibility/panel');
  return { default: m.AccessibilityPanel };
});

/**
 * The in-app accessibility panel: a right pane opened through the panel store, docked from
 * 768 and a non-modal sheet below it, so each change shows on the page as it is made.
 */
export function AccessibilityPanelHost(): React.JSX.Element {
  const open = useAccessibilityPanelStore((state) => state.open);
  const setOpen = useAccessibilityPanelStore((state) => state.setOpen);

  React.useEffect(() => {
    if (open) useRightPane.getState().open(PANE_ID);
  }, [open]);

  // Another pane taking the slot closes this one without its close control, so the flag
  // is cleared on every way out and More options can open the panel again.
  React.useEffect(
    () =>
      useRightPane.subscribe((state, previous) => {
        if (previous.active === PANE_ID && state.active !== PANE_ID) setOpen(false);
      }),
    [setOpen]
  );

  const close = React.useCallback((): void => {
    setOpen(false);
  }, [setOpen]);

  return (
    <RightPane
      id={PANE_ID}
      title="Accessibility"
      width="22rem"
      surface="background"
      head="display"
      phone="sheet"
      onClose={close}
    >
      <React.Suspense fallback={null}>
        <div className="px-2 pt-2 pb-6">
          <AccessibilityPanel host="app" />
        </div>
      </React.Suspense>
    </RightPane>
  );
}
