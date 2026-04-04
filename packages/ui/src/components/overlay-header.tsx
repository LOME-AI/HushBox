import * as React from 'react';
import { cn } from '../lib/utilities';

export interface OverlayHeaderProps {
  title: string;
  /** Optional description below the title. Accepts ReactNode for inline JSX. */
  description?: React.ReactNode;
  className?: string;
}

export function OverlayHeader({
  title,
  description,
  className,
}: Readonly<OverlayHeaderProps>): React.JSX.Element {
  return (
    <div className={cn(className)}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description !== undefined && (
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      )}
    </div>
  );
}
