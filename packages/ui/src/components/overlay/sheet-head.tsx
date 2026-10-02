import { XIcon } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { OverlayHeader } from './overlay-header';
import { CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';
import type * as React from 'react';

// The overlay's own close, taken out of its corner into the row: `relative` replaces `absolute`
// and still anchors the coarse target, and the corner offsets are released.
const SHEET_CLOSE_CLASS = cn(CLOSE_BUTTON_CLASS, 'relative top-auto right-auto');

interface SheetHeadProps {
  /** Inside an `Overlay`, this is also the sheet's accessible name. */
  title: string;
  onClose: () => void;
}

/** The title row a menu or popover shows while it is a sheet, with its close centred on the title. */
export function SheetHead({ title, onClose }: Readonly<SheetHeadProps>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <OverlayHeader title={title} className="min-w-0 flex-1 pr-0" />
      <button
        type="button"
        data-slot="overlay-close"
        className={SHEET_CLOSE_CLASS}
        onClick={onClose}
      >
        <XIcon />
        <span className="sr-only">Close</span>
      </button>
    </div>
  );
}
