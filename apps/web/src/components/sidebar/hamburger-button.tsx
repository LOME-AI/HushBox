import * as React from 'react';
import { Menu } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { IconButton } from '@hushbox/ui/button';
import { useUIStore } from '@/stores/ui/ui';

export function HamburgerButton(): React.JSX.Element {
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);

  return (
    <IconButton
      icon={Menu}
      onClick={() => {
        setMobileSidebarOpen(true);
      }}
      className="md:hidden"
      // The native flows find the button by this literal id.
      id="hamburger-button"
      data-testid={TEST_IDS.hamburgerButton}
      aria-label="Open menu"
    />
  );
}
