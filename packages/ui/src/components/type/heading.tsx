import { typeRoleClass } from './type-role-class';
import type * as React from 'react';
import type { TypeRole } from '@hushbox/shared/design-tokens';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const HEADING_ELEMENT = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
} as const satisfies Record<HeadingLevel, string>;

interface HeadingProps {
  /** The outline level; the variant, not the level, sets how the heading looks. */
  level: HeadingLevel;
  variant: TypeRole;
  tone?: 'signal' | 'ink';
  /** Draws one line, ending in an ellipsis when the text does not fit. */
  truncate?: boolean;
  id?: string;
  children: React.ReactNode;
}

/**
 * A heading at the outline level given, set by its type role. Signal Red comes from the
 * stylesheet's heading element rule, so the signal tone adds no colour class of its own
 * that could drift from that rule.
 */
export function Heading({
  level,
  variant,
  tone = 'signal',
  truncate = false,
  id,
  children,
}: Readonly<HeadingProps>): React.JSX.Element {
  const Element = HEADING_ELEMENT[level];
  const toneClass = tone === 'ink' ? ' text-foreground' : '';
  const truncateClass = truncate ? ' truncate' : '';
  return (
    <Element id={id} className={`${typeRoleClass(variant)}${toneClass}${truncateClass}`}>
      {children}
    </Element>
  );
}
