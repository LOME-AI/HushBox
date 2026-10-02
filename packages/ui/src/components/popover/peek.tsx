import * as React from 'react';

import { Popover as PopoverRoot, PopoverAnchor, PopoverContent } from '../primitives/popover';

interface PeekProps {
  /** The element the peek hangs above; `null` closes it. */
  anchor: Element | null;
  /** Escape, or a press outside, asks to close it. */
  onDismiss: () => void;
  children: React.ReactNode;
}

/** The least room kept between the peek and the edge of the viewport. */
const COLLISION_PADDING_PX = 8;

// The height is bounded by the room above the anchor as well as by the viewport: a viewport
// fraction alone still lets a tall peek run off the top, since the collision shift stops before it
// detaches from the anchor. The tail is cut rather than scrolled, because a layer that takes no
// pointer events cannot be scrolled.
const BOX_CLASS =
  'pointer-events-none max-h-[min(85vh,var(--radix-popover-content-available-height))] w-auto overflow-hidden p-0';

function keepFocusOnTheAnchor(event: Event): void {
  event.preventDefault();
}

/**
 * Radix positions the content inside a wrapper of its own that takes no props, so the box's
 * `pointer-events-none` never reaches it and the wrapper would still swallow clicks under it.
 */
function makeClickTransparent(node: HTMLElement | null): void {
  node
    ?.closest<HTMLElement>('[data-radix-popper-content-wrapper]')
    ?.style.setProperty('pointer-events', 'none');
}

/**
 * A preview hung above an element the reader rests on. It never takes focus, so focus stays on
 * the anchor; it takes no pointer events; and it stays anchored at every width, with no sheet.
 * Its children render directly inside the height-capped box, so a child can measure that box as
 * its parent, and the children set its width.
 */
function Peek({ anchor, onDismiss, children }: Readonly<PeekProps>): React.JSX.Element {
  const anchorRef = React.useMemo(() => ({ current: anchor }), [anchor]);
  return (
    <PopoverRoot
      open={anchor !== null}
      // There is no trigger to open from, so the only change Radix can report is a dismissal.
      onOpenChange={onDismiss}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      {anchor !== null && (
        <PopoverContent
          ref={makeClickTransparent}
          side="top"
          align="start"
          collisionPadding={COLLISION_PADDING_PX}
          className={BOX_CLASS}
          onOpenAutoFocus={keepFocusOnTheAnchor}
          onCloseAutoFocus={keepFocusOnTheAnchor}
        >
          {children}
        </PopoverContent>
      )}
    </PopoverRoot>
  );
}

export { Peek };
export type { PeekProps };
