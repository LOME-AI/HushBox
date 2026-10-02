import { cn } from '../../lib/utilities';
import type * as React from 'react';

export interface IconGlyphProps {
  className?: string;
  'aria-hidden'?: boolean;
}

export type IconComponent = React.ComponentType<IconGlyphProps>;

export type IconSize = 'xs' | 'sm' | 'md' | 'md-lg' | 'lg' | 'xl' | 'display';

/**
 * The one icon size scale. A caller that needs another size adds a step here
 * rather than a local class. The literals stay in this `.tsx` file because
 * the shared stylesheet's class scan of `packages/ui` reads `.tsx` files only.
 */
const SIZE_CLASS: Readonly<Record<IconSize, string>> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  'md-lg': 'size-4.5',
  lg: 'size-5',
  xl: 'size-6',
  display: 'size-16',
};

interface IconProps {
  icon: IconComponent;
  size?: IconSize;
  label?: string;
  className?: string;
}

/**
 * Draws a glyph at a size from the scale, decorative unless labelled. A glyph
 * takes only a class and `aria-hidden`, so a labelled icon names a wrapper and
 * hides the glyph inside it; the wrapper is a block because the base layer
 * draws a bare svg as one.
 */
export function Icon({
  icon: Glyph,
  size = 'md',
  label,
  className,
}: Readonly<IconProps>): React.JSX.Element {
  if (label === undefined) {
    return <Glyph aria-hidden className={cn(SIZE_CLASS[size], className)} />;
  }
  return (
    <span role="img" aria-label={label} className={cn('block', SIZE_CLASS[size], className)}>
      <Glyph aria-hidden className="size-full" />
    </span>
  );
}
