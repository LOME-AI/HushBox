import * as React from 'react';
import { cn } from '../../lib/utilities';

interface CalloutProps extends React.ComponentProps<'div'> {
  variant?: 'info' | 'privacy' | 'warning';
  title?: string;
}

function Callout({
  variant = 'info',
  title,
  className,
  children,
  ...props
}: Readonly<CalloutProps>): React.JSX.Element {
  return (
    <div
      data-slot="callout"
      data-variant={variant}
      className={cn(
        'rounded-lg border p-4',
        variant === 'privacy' && 'border-primary/30 bg-primary/5',
        variant === 'info' && 'border-border bg-muted/50',
        variant === 'warning' && 'border-warning/30 bg-warning/5',
        className
      )}
      {...props}
    >
      {title && (
        <p data-slot="callout-title" className="mb-1 text-sm font-semibold">
          {title}
        </p>
      )}
      <div className="text-muted-foreground text-sm">{children}</div>
    </div>
  );
}

export { Callout, type CalloutProps };
