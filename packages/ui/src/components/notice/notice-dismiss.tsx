'use client';

import { X } from 'lucide-react';

import { IconButton } from '../button/icon-button';
import { useNoticePlacement } from './notice-placement';
import type * as React from 'react';

interface NoticeDismissProps {
  onDismiss: () => void;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * A notice's dismiss control. Under the composer it is today's 1.5rem square with a 2.75rem
 * target laid over it on touch; elsewhere a 1.75rem square that grows to 2.75rem on touch.
 */
function NoticeDismiss({
  onDismiss,
  'aria-label': ariaLabel = 'Dismiss notification',
  'data-testid': testId,
}: Readonly<NoticeDismissProps>): React.JSX.Element {
  const composer = useNoticePlacement() === 'composer';
  return (
    <IconButton
      icon={X}
      aria-label={ariaLabel}
      onClick={onDismiss}
      {...(composer
        ? { size: '2xs', hitArea: 'extend', className: 'text-foreground [&_svg]:size-3' }
        : {
            size: 'xs',
            hitArea: 'grow',
            className: 'text-muted-foreground hover:text-foreground',
          })}
      {...(testId !== undefined && { 'data-testid': testId })}
    />
  );
}

export { NoticeDismiss };
