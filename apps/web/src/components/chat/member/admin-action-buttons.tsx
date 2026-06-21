import * as React from 'react';
import { Plus, Link as LinkIcon } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';

interface AdminActionButtonsProps {
  collapsed: boolean;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

export function AdminActionButtons({
  collapsed,
  onAddMember,
  onInviteLink,
}: Readonly<AdminActionButtonsProps>): React.JSX.Element {
  return (
    <>
      <SidebarActionButton
        icon={<Plus className="h-4 w-4" />}
        label="New Member"
        onClick={() => onAddMember?.()}
        {...(collapsed && { collapsed: true })}
        testId={TEST_IDS.newMemberButton}
      />
      <SidebarActionButton
        icon={<LinkIcon className="h-4 w-4" />}
        label="Invite via Link"
        onClick={() => onInviteLink?.()}
        {...(collapsed && { collapsed: true })}
        testId={TEST_IDS.inviteLinkButton}
      />
    </>
  );
}
