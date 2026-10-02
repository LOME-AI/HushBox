import * as React from 'react';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { cn } from '../../lib/utilities';

/** A busy mark in the current colour; it holds still while motion is reduced. */
function Spinner({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  const animated = !useReducedMotion();

  return (
    <span
      data-slot="spinner"
      aria-hidden="true"
      className={cn(
        'size-4 shrink-0 rounded-full border-2 border-current border-r-transparent',
        animated && 'animate-spin',
        className
      )}
    />
  );
}

export { Spinner };
