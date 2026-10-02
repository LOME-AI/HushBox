import * as React from 'react';
import { cn } from '@hushbox/ui';
import { TEST_ID_BUILDERS } from '@hushbox/shared';

const SIZE_CLASSES = {
  sm: 'size-6 text-xs',
  md: 'size-8 text-sm',
} as const;

interface MemberAvatarProps {
  initial: string;
  isOnline: boolean;
  size: keyof typeof SIZE_CLASSES;
  testIdPrefix: string;
  entityId: string;
  className?: string;
  'data-testid'?: string;
}

export function MemberAvatar({
  initial,
  isOnline,
  size,
  testIdPrefix,
  entityId,
  className,
  'data-testid': dataTestId,
}: Readonly<MemberAvatarProps>): React.JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      className={cn(
        'bg-muted text-muted-foreground relative flex items-center justify-center rounded-full font-medium',
        SIZE_CLASSES[size],
        className
      )}
    >
      {initial}
      {isOnline && (
        <div
          data-testid={TEST_ID_BUILDERS.onlineFor(testIdPrefix, entityId)}
          className="ring-background bg-success absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
        />
      )}
    </div>
  );
}
