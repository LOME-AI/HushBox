import { ButtonRow } from '../button/button-row';
import type * as React from 'react';

/** An overlay's actions, laid out as a button row. */
export function OverlayFooter({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <ButtonRow>{children}</ButtonRow>;
}
