import * as React from 'react';

import { cn } from '../../lib/utilities';
import { drawnButtonClasses } from './button-classes';
import { ButtonFrame } from './button-frame';

type IconButtonSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<React.ComponentProps<'button'>, 'children'> {
  'aria-label': string;
  icon: React.ComponentType<{ className?: string }>;
  variant?: 'ghost';
  size?: IconButtonSize;
  hitArea?: 'grow' | 'extend';
}

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  '2xs': 'size-6',
  xs: 'size-7',
  sm: 'size-8',
  md: 'size-9',
  lg: 'size-10',
};

// `grow` makes the square itself 2.75rem on touch; `extend` keeps the drawn square and
// lays an invisible 2.75rem target over its centre, for a row whose geometry must hold.
const HIT_AREA_CLASSES = {
  grow: 'pointer-coarse:size-11',
  extend:
    'relative pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-1/2',
} as const;

function IconButton({
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  hitArea = 'grow',
  className,
  ...props
}: Readonly<IconButtonProps>): React.JSX.Element {
  return (
    <ButtonFrame
      {...props}
      data-slot="icon-button"
      data-variant={variant}
      data-size={size}
      className={cn(
        drawnButtonClasses(variant),
        'p-0',
        SIZE_CLASSES[size],
        HIT_AREA_CLASSES[hitArea],
        className
      )}
    >
      <Icon />
    </ButtonFrame>
  );
}

export { IconButton, HIT_AREA_CLASSES, type IconButtonProps, type IconButtonSize };
