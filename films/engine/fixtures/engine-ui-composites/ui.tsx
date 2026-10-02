import { Button, Sheet, SheetContent, SheetTitle } from '@hushbox/ui';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import { Overlay, OverlayContent } from '@hushbox/ui/overlay';

import { beatAt } from './timeline.js';

import type { CSSProperties } from 'react';
import type { UiProps } from '../../look/index.js';

const MENU_AT: CSSProperties = { position: 'absolute', left: 120, top: 300 };

/** The film opens and closes each composite from the frame; nothing on the page may. */
function frameDecides(): void {
  // The beat alone decides what is open.
}

/**
 * Keeps an overlay from moving focus as it opens: focus then rests where the
 * composite itself puts it, the same on every frame it is open.
 */
function holdFocus(event: Event): void {
  event.preventDefault();
}

/**
 * The app's Menu, a dialog through its Overlay router and a sheet, opened in
 * turn by the frame's beat, none given a container: each reaches the UI
 * layer's element through the layer's provider.
 * @toolContract
 */
export function Ui({ frame }: Readonly<UiProps>): React.JSX.Element {
  const { menu, dialog, sheet } = beatAt(frame);
  return (
    <>
      <div style={MENU_AT}>
        <Menu
          trigger={<Button>Conversation</Button>}
          title="Conversation"
          align="start"
          open={menu}
          onOpenChange={frameDecides}
        >
          <MenuItem title="Rename" onSelect={frameDecides} />
          <MenuItem title="Fork" onSelect={frameDecides} />
        </Menu>
      </div>
      <Overlay
        open={dialog}
        onOpenChange={frameDecides}
        ariaLabel="Share conversation"
        onOpenAutoFocus={holdFocus}
      >
        <OverlayContent size="sm">Only people you invite can read it.</OverlayContent>
      </Overlay>
      <Sheet open={sheet} onOpenChange={frameDecides}>
        <SheetContent side="top" aria-describedby={undefined} onOpenAutoFocus={holdFocus}>
          <SheetTitle className="p-6">Encrypted on this device before it is stored.</SheetTitle>
        </SheetContent>
      </Sheet>
    </>
  );
}
