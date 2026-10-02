import * as React from 'react';
import { Link as LinkIcon, Plus } from '@hushbox/ui/icons';
import { TEST_IDS } from '@hushbox/shared';
import { SidebarActionRow } from '@/components/shared/sidebar-action-row';

interface AdminActionButtonsProps {
  showAddMember: boolean;
  showInviteLink: boolean;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

/** The member pane's two management rows, drawn as the sidebar's outline action rows. */
export function AdminActionButtons({
  showAddMember,
  showInviteLink,
  onAddMember,
  onInviteLink,
}: Readonly<AdminActionButtonsProps>): React.JSX.Element {
  return (
    <>
      {showAddMember && (
        <SidebarActionRow
          icon={Plus}
          label="Add Member"
          onClick={() => onAddMember?.()}
          testId={TEST_IDS.newMemberButton}
        />
      )}
      {showInviteLink && (
        <SidebarActionRow
          icon={LinkIcon}
          label="Invite via Link"
          onClick={() => onInviteLink?.()}
          testId={TEST_IDS.inviteLinkButton}
        />
      )}
    </>
  );
}
