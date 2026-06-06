import * as React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';

export function HamburgerButton(): React.JSX.Element {
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        setMobileSidebarOpen(true);
      }}
      className="md:hidden"
      id="hamburger-button"
      data-testid={TEST_IDS.hamburgerButton}
      aria-label="Open menu"
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}
