import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Facepile } from '@/components/shared/facepile';
import { MEMBERS_PANE_ID } from '@/components/chat/member/member-sidebar';
import { useRightPane } from '@/stores/ui/right-pane';

interface MemberFacepileProps {
  members: readonly { name: string; online: boolean }[];
}

/** The header's way into the members pane from 768; below that the member strip takes it. */
export function MemberFacepile({
  members,
}: Readonly<MemberFacepileProps>): React.JSX.Element | null {
  return (
    <Facepile
      members={members}
      data-testid={TEST_IDS.memberFacepile}
      onOpen={() => {
        useRightPane.getState().open(MEMBERS_PANE_ID);
      }}
    />
  );
}
