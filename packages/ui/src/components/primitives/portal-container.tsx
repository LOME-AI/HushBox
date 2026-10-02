'use client';

import * as React from 'react';

const PortalContainerContext = React.createContext<HTMLElement | null>(null);

/**
 * Gives every overlay beneath it this element to portal into in place of the document body,
 * so a surface that places, themes or captures its own subtree keeps its overlays inside it.
 */
function PortalContainerProvider({
  container,
  children,
}: Readonly<{ container: HTMLElement; children: React.ReactNode }>): React.JSX.Element {
  return <PortalContainerContext value={container}>{children}</PortalContainerContext>;
}

/**
 * The element an overlay portals into: its own `container`, else the nearest provider's, else
 * nothing, which a Radix portal reads as the document body.
 */
function usePortalContainer<T>(container: T | undefined): T | HTMLElement | undefined {
  const provided = React.useContext(PortalContainerContext);
  return container ?? provided ?? undefined;
}

export { PortalContainerProvider, usePortalContainer };
