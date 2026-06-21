import * as React from 'react';

import { cn } from '../lib/utilities';
import { Button } from './button';

type IconButtonProps = React.ComponentPropsWithRef<typeof Button> &
  Readonly<{ 'aria-label': string }>;

function IconButton({ className, ...props }: IconButtonProps): React.JSX.Element {
  return (
    <Button variant="ghost" size="icon" className={cn('h-6 w-6 shrink-0', className)} {...props} />
  );
}

export { IconButton, type IconButtonProps };
