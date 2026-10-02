import type * as React from 'react';

/**
 * The content between an overlay's header and footer. It is the part that gives way and scrolls
 * when the overlay is taller than the room, so the header and footer stay in view. The inset
 * padding, cancelled by an equal negative margin so content does not move, keeps what reaches past
 * a control inside the scroll edge, which clips it: 0.875rem inline for a 2.75rem coarse hit area
 * around a control as small as 1rem, 0.25rem on the block axis for a focus ring.
 */
export function OverlayBody({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="-mx-3.5 -my-1 flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-3.5 py-1">
      {children}
    </div>
  );
}
