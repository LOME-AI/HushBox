import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { ChevronRight, Icon } from '@hushbox/ui/icons';
import { AvatarPile } from '@/components/shared/facepile';
import { MEMBERS_PANE_ID } from '@/components/chat/member/member-sidebar';
import { useRightPane } from '@/stores/ui/right-pane';

type StripMembers = readonly { name: string; online: boolean }[];

interface MemberStripProps {
  /** Undefined while the member list loads: the row holds its height, empty. */
  members: StripMembers | undefined;
}

function countLine(members: StripMembers): string {
  const online = members.filter((member) => member.online).length;
  const noun = members.length === 1 ? 'member' : 'members';
  return `${String(members.length)} ${noun} · ${String(online)} online`;
}

/**
 * The row under the header below 768, where the header has no room for the facepile: who
 * is here, and the way into the members pane. The pile is decorative, so the button is
 * named by its count line.
 */
export function MemberStrip({ members }: Readonly<MemberStripProps>): React.JSX.Element {
  const line = members === undefined ? '' : countLine(members);
  return (
    <button
      type="button"
      data-testid={TEST_IDS.memberStrip}
      aria-label={members === undefined ? 'Show members' : `${line}. Show members`}
      onClick={() => {
        useRightPane.getState().open(MEMBERS_PANE_ID);
      }}
      className="bg-background text-foreground hover:bg-background-subtle focus-visible:ring-ring text-ui-sm flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-b px-4 py-1.5 text-start focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
    >
      <AvatarPile
        members={members ?? []}
        className="shrink-0 [&>[data-slot=avatar]]:size-6 [&>[data-slot=avatar]]:text-[0.6875rem]"
      />
      <span className="min-w-0 flex-1 truncate">{line}</span>
      <Icon icon={ChevronRight} size="sm" className="text-muted-foreground shrink-0" />
    </button>
  );
}
