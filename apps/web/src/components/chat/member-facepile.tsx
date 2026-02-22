import * as React from 'react';
import { cn } from '@hushbox/ui';
import { displayUsername } from '@hushbox/shared';

const MAX_VISIBLE_AVATARS = 3;

interface MemberFacepileProps {
  members: { id: string; username: string }[];
  onlineMemberIds: Set<string>;
  onFacepileClick: () => void;
}

export function MemberFacepile({
  members,
  onlineMemberIds,
  onFacepileClick,
}: Readonly<MemberFacepileProps>): React.JSX.Element | null {
  if (members.length === 0) {
    return null;
  }

  const visibleMembers = members.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = members.length - MAX_VISIBLE_AVATARS;

  return (
    <button
      type="button"
      data-testid="member-facepile"
      className="flex cursor-pointer items-center"
      onClick={onFacepileClick}
    >
      {visibleMembers.map((member, index) => (
        <div
          key={member.id}
          data-testid={`member-avatar-${member.id}`}
          className={cn(
            'border-background bg-muted text-muted-foreground relative flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium',
            index > 0 && '-ml-2'
          )}
        >
          {displayUsername(member.username).charAt(0)}
          {onlineMemberIds.has(member.id) && (
            <span
              data-testid={`online-indicator-${member.id}`}
              className="absolute right-0 bottom-0 h-2 w-2 rounded-full border border-white bg-green-500"
            />
          )}
        </div>
      ))}
      {overflowCount > 0 && (
        <span
          data-testid="member-count-badge"
          className="bg-muted text-muted-foreground -ml-2 flex h-6 items-center justify-center rounded-full px-1.5 text-xs font-medium"
        >
          +{overflowCount}
        </span>
      )}
    </button>
  );
}
