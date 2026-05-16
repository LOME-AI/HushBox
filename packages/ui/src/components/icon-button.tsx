import * as React from 'react';

import { cn } from '../lib/utilities';
import { Button } from './button';

type IconButtonProps = React.ComponentPropsWithRef<typeof Button> &
  Readonly<{ 'aria-label': string }>;

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, ...props }, ref) => (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className={cn('h-6 w-6 shrink-0', className)}
      {...props}
    />
  )
);
IconButton.displayName = 'IconButton';

export { IconButton, type IconButtonProps };
