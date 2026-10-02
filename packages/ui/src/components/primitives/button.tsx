import * as React from 'react';

import { cn } from '../../lib/utilities';
import {
  Button as DoorButton,
  type ButtonProps as DoorButtonProps,
  type ButtonSize,
} from '../button/button';
import { buttonLookClasses } from '../button/button-classes';
import { ButtonFrame } from '../button/button-frame';

type SquareSize = 'icon' | 'icon-sm' | 'icon-lg';

type ButtonProps = Omit<DoorButtonProps, 'size'> & { size?: ButtonSize | SquareSize };

// The squares callers used before the icon button existed, kept as the ghost, secondary
// and default callers draw them: no border, the pointer cursor in every state, no touch
// growth, and a faded disabled state that lets pointer events reach a wrapper.
const SQUARE_CLASSES: Record<SquareSize, string> = {
  icon: 'size-11',
  'icon-sm': 'size-8',
  'icon-lg': 'size-12',
};

const SQUARE_DISABLED = 'disabled:pointer-events-none disabled:opacity-50';

function isSquare(size: ButtonProps['size']): size is SquareSize {
  return size !== undefined && size in SQUARE_CLASSES;
}

function Button({
  size,
  variant = 'default',
  className,
  ...props
}: Readonly<ButtonProps>): React.JSX.Element {
  if (isSquare(size) && variant !== 'bare') {
    return (
      <ButtonFrame
        {...props}
        data-variant={variant}
        data-size={size}
        className={cn(
          'cursor-pointer',
          buttonLookClasses(variant),
          'border-0',
          SQUARE_CLASSES[size],
          SQUARE_DISABLED,
          className
        )}
      />
    );
  }
  const doorSize = isSquare(size) ? undefined : size;
  return (
    <DoorButton
      {...props}
      variant={variant}
      {...(doorSize !== undefined && { size: doorSize })}
      className={className}
    />
  );
}

export { Button };
export { buttonVariants } from '../button/button';
