import * as React from 'react';
import { LAYOUT } from '@hushbox/shared/design-tokens';

/**
 * The chat column: the chat measure, centred, between the band's gutters. The measure
 * caps the content box, so the gutters sit outside it. Every surface whose edges must
 * line up with the thread's (the composer, the messages) is set in this one column.
 */
export function ChatColumn({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="mx-auto box-content px-4 md:px-6" style={{ maxWidth: LAYOUT.measureChat }}>
      {children}
    </div>
  );
}
