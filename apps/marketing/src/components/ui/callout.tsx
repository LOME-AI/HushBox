import * as React from 'react';
import { cn } from '@hushbox/ui';

interface CalloutProps extends React.ComponentProps<'div'> {
  title?: string;
}

function Callout({
  title,
  className,
  children,
  ...props
}: Readonly<CalloutProps>): React.JSX.Element {
  return (
    <div
      data-slot="callout"
      className={cn('border-brand-red/30 bg-brand-red/5 rounded-lg border p-4', className)}
      {...props}
    >
      {title && (
        <p
          data-slot="callout-title"
          className="text-foreground text-body-sub mb-1 leading-[1.55] font-semibold"
        >
          {title}
        </p>
      )}
      <div className="text-foreground text-body-sub leading-[1.55]">{children}</div>
    </div>
  );
}

export { Callout };
