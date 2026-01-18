import * as React from 'react';
import { cn } from '@lome-chat/ui';

interface StableContentProps {
  /** When false, shows skeleton or hidden content */
  isStable: boolean;
  /** Content to show when stable */
  children: React.ReactNode;
  /** Optional skeleton to show during loading (takes priority over preserveLayout) */
  skeleton?: React.ReactNode;
  /** If true, content is invisible but occupies space during loading */
  preserveLayout?: boolean;
  /** CSS class to apply to wrapper */
  className?: string;
  /** Test ID for testing */
  'data-testid'?: string;
}

/**
 * Declarative wrapper for rendering content only when data is stable.
 * Prevents flash of incorrect state by conditionally rendering.
 *
 * Does NOT add any animation - components choose their own animation strategy.
 */
export function StableContent({
  isStable,
  children,
  skeleton,
  preserveLayout = false,
  className,
  'data-testid': testId,
}: StableContentProps): React.ReactNode {
  // Show skeleton while loading (if provided)
  if (!isStable && skeleton) {
    return skeleton;
  }

  // Preserve layout: render children but invisible
  if (!isStable && preserveLayout) {
    return (
      <div className={cn('invisible', className)} data-testid={testId}>
        {children}
      </div>
    );
  }

  // Not stable and no skeleton/preserveLayout: render nothing
  if (!isStable) {
    return null;
  }

  // Stable: render children (with wrapper if className or testId provided)
  if (className || testId) {
    return (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    );
  }

  return children;
}
