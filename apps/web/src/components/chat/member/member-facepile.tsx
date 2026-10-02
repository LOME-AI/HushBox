import * as React from 'react';
import { cn } from '@hushbox/ui';
import { displayUsername, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { MemberAvatar } from '@/components/chat/member/member-avatar';

const MAX_VISIBLE_AVATARS = 3;

// Its own prefix, because the header and the collapsed member rail are mounted
// together and the rail's avatars build their dot ids from "member-avatar".
const FACEPILE_TEST_ID_PREFIX = 'member-facepile';

interface MemberFacepileProps {
  // A link-guest member has no user account: both `userId` and `username` are
  // null (backend `members.ts` types `username` nullable, and the users
  // left-join yields null for a guest with no userId).
  members: { id: string; userId: string | null; username: string | null }[];
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
      // State-neutral, matching the panel's own title: the click toggles the
      // member panel, so a name stating a direction is wrong in one state.
      aria-label={`Members (${String(members.length)})`}
      data-testid={TEST_IDS.memberFacepile}
      className="flex cursor-pointer items-center"
      onClick={onFacepileClick}
    >
      {visibleMembers.map((member, index) => (
        <MemberAvatar
          key={member.id}
          data-testid={TEST_ID_BUILDERS.memberAvatar(member.id)}
          initial={member.username === null ? '?' : displayUsername(member.username).charAt(0)}
          isOnline={member.userId !== null && onlineMemberIds.has(member.userId)}
          size="sm"
          testIdPrefix={FACEPILE_TEST_ID_PREFIX}
          entityId={member.id}
          // The rim is the header's own colour: overlapping discs need one to
          // read as separate, and the sidebar's spaced-out avatars do not.
          className={cn('border-background border', index > 0 && '-ml-2')}
        />
      ))}
      {overflowCount > 0 && (
        <span
          data-testid={TEST_IDS.memberCountBadge}
          className="bg-muted text-muted-foreground -ml-2 flex h-6 items-center justify-center rounded-full px-1.5 text-xs font-medium"
        >
          +{overflowCount}
        </span>
      )}
    </button>
  );
}
