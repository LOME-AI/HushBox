import * as React from 'react';
import { env } from '@/lib/env';

interface DevOnlyProps {
  children: React.ReactNode;
  showBorder?: boolean;
}

export function DevOnly({ children, showBorder = true }: DevOnlyProps): React.ReactNode {
  if (!env.isDev) {
    return null;
  }

  if (!showBorder) {
    return children;
  }

  return (
    <div className="relative rounded-md border-2 border-dashed border-amber-500/50 p-2">
      <span className="bg-background absolute -top-2.5 left-2 px-1 text-xs font-medium text-amber-500">
        Development Only
      </span>
      {children}
    </div>
  );
}
