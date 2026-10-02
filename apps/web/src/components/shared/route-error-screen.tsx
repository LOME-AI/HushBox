import * as React from 'react';
import { ErrorFallback } from '@hushbox/ui';
import type { ErrorComponentProps } from '@tanstack/react-router';

/**
 * The router's error screen for a route that declares none. A minimum height,
 * never a fixed one, so content taller than the route (large type, loose
 * spacing) grows the box and scrolls instead of being cut off above the fold
 * by the centring.
 */
export function RouteErrorScreen({
  error,
  reset,
}: Readonly<ErrorComponentProps>): React.JSX.Element {
  return (
    <div className="flex min-h-full items-center justify-center">
      <ErrorFallback error={error} reset={reset} />
    </div>
  );
}
