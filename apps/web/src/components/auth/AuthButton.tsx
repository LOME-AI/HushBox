import * as React from 'react';
import { Button, cn } from '@lome-chat/ui';

type ButtonProps = React.ComponentProps<typeof Button>;

export function AuthButton({ children, className, ...props }: ButtonProps): React.JSX.Element {
  return (
    <Button
      {...props}
      className={cn('h-14 font-black', className)}
      style={{
        clipPath: 'polygon(0 0, 100% 0, 95% 100%, 0 100%)',
        borderRadius: '4px',
      }}
    >
      {children}
    </Button>
  );
}
