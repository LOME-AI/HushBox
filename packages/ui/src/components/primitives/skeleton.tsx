import * as React from 'react';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { cn } from '../../lib/utilities';

/**
 * Loading placeholder. Honors the merged reduced-motion signal internally (OS
 * `prefers-reduced-motion` OR the a11y widget's "stop animations") by dropping
 * the pulse class outright rather than relying on the global `html.reduced-motion`
 * duration clamp. `data-animated` reflects the reduced state for test determinism.
 */
function Skeleton({
  className,
  ...props
}: Readonly<React.ComponentProps<'div'>>): React.JSX.Element {
  const animated = !useReducedMotion();

  return (
    <div
      data-slot="skeleton"
      data-animated={animated}
      aria-hidden="true"
      className={cn('bg-muted rounded-md', animated && 'animate-pulse', className)}
      {...props}
    />
  );
}

export { Skeleton };
