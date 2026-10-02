import type * as React from 'react';

import type { IconGlyphProps } from './icon';

/**
 * The /welcome hero's scroll arrow. Its own path, not lucide's `ChevronDown`,
 * whose path differs, so the hero's arrow keeps its drawing.
 */
export function ScrollChevron({
  className,
  'aria-hidden': ariaHidden,
}: Readonly<IconGlyphProps>): React.JSX.Element {
  return (
    <svg
      className={className}
      aria-hidden={ariaHidden}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
