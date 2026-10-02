import type { JSX } from 'react';

/**
 * When something happened, wherever the console says so. A stored moment is
 * already the day it is read as, so there is nothing to format and no locale to
 * apply; what this owns is that every surface emits the same `<time>` element
 * rather than a bare string.
 */
export function Stamp({ at }: Readonly<{ at: string }>): JSX.Element {
  return (
    <time dateTime={at} className="font-mono">
      {at}
    </time>
  );
}
