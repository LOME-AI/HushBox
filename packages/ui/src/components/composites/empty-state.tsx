import * as React from 'react';

import { cn } from '../../lib/utilities';

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Readonly<
  React.ComponentProps<'div'> & {
    icon?: React.ReactNode | undefined;
    title: React.ReactNode;
    description?: React.ReactNode | undefined;
    action?: React.ReactNode | undefined;
  }
>): React.JSX.Element {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className
      )}
      {...props}
    >
      {icon !== undefined && (
        <div
          data-slot="empty-state-icon"
          aria-hidden="true"
          className="text-muted-foreground [&_svg]:size-8"
        >
          {icon}
        </div>
      )}
      <p data-slot="empty-state-title" className="text-foreground text-sm font-medium">
        {title}
      </p>
      {description !== undefined && (
        <p
          data-slot="empty-state-description"
          className="text-muted-foreground max-w-prose text-sm"
        >
          {description}
        </p>
      )}
      {action !== undefined && (
        <div data-slot="empty-state-action" className="pt-2">
          {action}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
