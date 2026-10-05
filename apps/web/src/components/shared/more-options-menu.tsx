import * as React from 'react';
import { IconButton } from '@hushbox/ui/button';
import { Accessibility, Ellipsis } from '@hushbox/ui/icons';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import { TEST_IDS } from '@hushbox/shared';
import { useAccessibilityPanelStore } from '@/stores/ui/accessibility-panel';

/** The last control in every app header: the one menu that opens the accessibility panel. */
export function MoreOptionsMenu(): React.JSX.Element {
  const setPanelOpen = useAccessibilityPanelStore((state) => state.setOpen);

  return (
    <Menu
      title="More options"
      trigger={
        <IconButton
          icon={Ellipsis}
          aria-label="More options"
          data-testid={TEST_IDS.moreOptionsButton}
        />
      }
    >
      <MenuItem
        icon={Accessibility}
        title="Accessibility"
        data-testid={TEST_IDS.moreOptionsAccessibility}
        runAfterClose
        onSelect={() => {
          setPanelOpen(true);
        }}
      />
    </Menu>
  );
}
