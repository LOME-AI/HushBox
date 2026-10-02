'use client';

import * as React from 'react';

type OverlayPresentation = 'sheet' | 'dialog';

const OverlayPresentationContext = React.createContext<OverlayPresentation | null>(null);

/** How the enclosing `Overlay` presents: a bottom sheet, a centred dialog, or `null` outside one. */
function useOverlayPresentation(): OverlayPresentation | null {
  return React.useContext(OverlayPresentationContext);
}

export { OverlayPresentationContext, useOverlayPresentation };
export type { OverlayPresentation };
