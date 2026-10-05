import * as React from 'react';
import { Lock } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { RightPane } from '@/components/shared/right-pane';
import { useConversationBudgets } from '@/hooks/billing/use-conversation-budgets';
import { useLinkGuestActive } from '@/lib/auth/link-guest-auth';
import {
  MemberSidebarBody,
  type MemberEntry,
  type LinkEntry,
  type MemberSidebarCallbacks,
  type MemberSidebarBodyProps,
} from '@/components/chat/member/member-sidebar-body';
import { MemberSidebarFooter } from '@/components/chat/member/member-sidebar-footer';
import type { MemberPrivilege } from '@hushbox/shared';

export const MEMBERS_PANE_ID = 'members';

function keepNoOpenState(): void {
  // RightPane clears the open pane itself, and the members pane holds no open flag to reset.
}

interface MemberSidebarProps extends MemberSidebarCallbacks {
  members?: MemberEntry[] | undefined;
  links?: LinkEntry[] | undefined;
  onlineMemberIds?: Set<string> | undefined;
  currentUserId?: string | undefined;
  currentUserLinkId?: string | null | undefined;
  currentUserPrivilege?: MemberPrivilege | undefined;
  conversationId?: string | undefined;
}

function buildOptionalCallbackProps(
  props: Readonly<MemberSidebarProps>
): Partial<MemberSidebarBodyProps> {
  return {
    ...(props.onRemoveMember !== undefined && { onRemoveMember: props.onRemoveMember }),
    ...(props.onChangePrivilege !== undefined && { onChangePrivilege: props.onChangePrivilege }),
    ...(props.onRevokeLinkClick !== undefined && { onRevokeLinkClick: props.onRevokeLinkClick }),
    ...(props.onSaveLinkName !== undefined && { onSaveLinkName: props.onSaveLinkName }),
    ...(props.onChangeLinkPrivilege !== undefined && {
      onChangeLinkPrivilege: props.onChangeLinkPrivilege,
    }),
    ...(props.onBudgetSettingsClick !== undefined && {
      onBudgetSettingsClick: props.onBudgetSettingsClick,
    }),
    ...(props.onLeaveClick !== undefined && { onLeaveClick: props.onLeaveClick }),
    ...(props.onAddMember !== undefined && { onAddMember: props.onAddMember }),
    ...(props.onInviteLink !== undefined && { onInviteLink: props.onInviteLink }),
  };
}

interface BuildBodyPropsInput {
  props: Readonly<MemberSidebarProps>;
  members: NonNullable<MemberSidebarProps['members']>;
  currentUserId: string;
  currentUserPrivilege: MemberPrivilege;
  conversationId: string;
  budgets: MemberSidebarBodyProps['budgets'];
}

function buildMemberSidebarBodyProps(input: Readonly<BuildBodyPropsInput>): MemberSidebarBodyProps {
  return {
    members: input.members,
    links: input.props.links ?? [],
    onlineMemberIds: input.props.onlineMemberIds ?? new Set(),
    currentUserId: input.currentUserId,
    currentUserLinkId: input.props.currentUserLinkId ?? null,
    currentUserPrivilege: input.currentUserPrivilege,
    conversationId: input.conversationId,
    budgets: input.budgets,
    ...buildOptionalCallbackProps(input.props),
  };
}

function MemberSidebarLoadingContent(): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid={TEST_IDS.decryptingIndicator}
    >
      <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <Lock className="h-4 w-4 shrink-0" data-testid={TEST_IDS.decryptingLockIcon} />
        Decrypting...
      </span>
    </div>
  );
}

/** The members pane: who is in the conversation, its invite links, and its budgets foot. */
export function MemberSidebar(props: Readonly<MemberSidebarProps>): React.JSX.Element {
  const { members, currentUserPrivilege, conversationId } = props;
  const currentUserId = props.currentUserId ?? '';
  const isLoading = !members || !currentUserPrivilege || !conversationId;
  // The budgets route refuses a link guest outright, so a guest asks nothing, as the foot does.
  // Nobody asks before membership is known: the route answers a non-member 404.
  const isLinkGuest = useLinkGuestActive();
  const { data: budgets } = useConversationBudgets(
    isLinkGuest || isLoading ? null : conversationId
  );

  return (
    <RightPane
      id={MEMBERS_PANE_ID}
      title="Members"
      {...(isLoading ? {} : { titleAside: `· ${String(members.length)}` })}
      width="20rem"
      surface="sidebar"
      head="plain"
      phone="fullscreen"
      onClose={keepNoOpenState}
      data-testid={TEST_IDS.memberSidebar}
    >
      <div className="flex h-full min-h-0 flex-col">
        {isLoading ? (
          <MemberSidebarLoadingContent />
        ) : (
          <>
            <MemberSidebarBody
              {...buildMemberSidebarBodyProps({
                props,
                members,
                currentUserId,
                currentUserPrivilege,
                conversationId,
                budgets,
              })}
            />
            <MemberSidebarFooter
              conversationId={conversationId}
              currentUserId={currentUserId}
              currentUserPrivilege={currentUserPrivilege}
              collapsed={false}
              onBudgetSettingsClick={props.onBudgetSettingsClick}
            />
          </>
        )}
      </div>
    </RightPane>
  );
}
