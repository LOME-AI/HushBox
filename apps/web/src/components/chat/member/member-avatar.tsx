import * as React from 'react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';

interface MemberAvatarProps {
  initial: string;
  isOnline: boolean;
  size: 'sm' | 'md';
  testIdPrefix: string;
  entityId: string;
}

export function MemberAvatar({
  initial,
  isOnline,
  size,
  testIdPrefix,
  entityId,
}: Readonly<MemberAvatarProps>): React.JSX.Element {
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  return (
    <div className="relative">
      <div
        className={`bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full ${textSize} font-medium`}
      >
        {initial}
      </div>
      {isOnline && (
        <div
          data-testid={TEST_ID_BUILDERS.onlineFor(testIdPrefix, entityId)}
          className="ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-green-500 ring-2"
        />
      )}
    </div>
  );
}
