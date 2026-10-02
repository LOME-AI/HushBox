import * as React from 'react';

import { cn } from '../../lib/utilities';
import { buttonVariants, type ButtonSize, type ButtonVariant } from './button-classes';
import { ButtonFrame } from './button-frame';

interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  block?: boolean;
  asChild?: boolean;
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  type,
  ...props
}: Readonly<ButtonProps>): React.JSX.Element {
  return (
    <ButtonFrame
      {...props}
      type={type ?? (variant === 'bare' ? 'button' : undefined)}
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
    />
  );
}

export { Button, type ButtonProps };
export { buttonVariants, type ButtonSize, type ButtonVariant } from './button-classes';
