import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@hushbox/ui';

import { phaseAt } from './timeline.js';

import type { CSSProperties } from 'react';
import type { UiProps } from '../../look/index.js';

const POPOVER_AT: CSSProperties = { position: 'absolute', left: 120, top: 200 };
const MENU_AT: CSSProperties = { position: 'absolute', left: 640, top: 200 };

/** The film sets each overlay's state from the frame; nothing on the page may change it. */
function ignoreOpenChange(): void {
  // The frame alone decides whether an overlay is open.
}

/**
 * Keeps an overlay from moving focus to or from its trigger: where focus
 * rests would otherwise depend on which overlays earlier frames opened, and a
 * focused trigger draws its ring. The menu takes focus into itself as it
 * opens, the same on every frame it is open.
 */
function keepFocus(event: Event): void {
  event.preventDefault();
}

/**
 * A popover and a dropdown menu, each opened or closed by the frame's stretch;
 * the UI layer's provider portals both into the layer's own element.
 * @toolContract
 */
export function Ui({ frame }: Readonly<UiProps>): React.JSX.Element {
  const { popover, menu } = phaseAt(frame);
  return (
    <>
      <div style={POPOVER_AT}>
        <Popover open={popover} onOpenChange={ignoreOpenChange}>
          <PopoverTrigger asChild>
            <Button variant="outline">Details</Button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            onOpenAutoFocus={keepFocus}
            onCloseAutoFocus={keepFocus}
          >
            Encrypted on this device before it is stored.
          </PopoverContent>
        </Popover>
      </div>
      <div style={MENU_AT}>
        <DropdownMenu open={menu} onOpenChange={ignoreOpenChange} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Options</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" onCloseAutoFocus={keepFocus}>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Fork</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
