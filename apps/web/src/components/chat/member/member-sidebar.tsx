import * as React from 'react';
import { createPortal } from 'react-dom';
import { Lock, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { SidebarPanel, useIsMobile } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useUIModalsStore } from '@/stores/ui-modals';
import {
  MemberSidebarBody,
  type MemberEntry,
  type LinkEntry,
  type MemberSidebarCallbacks,
  type MemberSidebarBodyProps,
} from '@/components/chat/member/member-sidebar-body';
import { MemberSidebarFooter } from '@/components/chat/member/member-sidebar-footer';

interface MemberSidebarProps extends MemberSidebarCallbacks {
  members?: MemberEntry[] | undefined;
  links?: LinkEntry[] | undefined;
  onlineMemberIds?: Set<string> | undefined;
  currentUserId?: string | undefined;
  currentUserLinkId?: string | null | undefined;
  currentUserPrivilege?: string | undefined;
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
  currentUserPrivilege: string;
  conversationId: string;
  collapsed: boolean;
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
    collapsed: input.collapsed,
    ...buildOptionalCallbackProps(input.props),
  };
}

interface MemberSidebarPanelConfig {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  headerTitle: string | undefined;
}

function computeHeaderTitle(
  collapsed: boolean,
  isLoading: boolean,
  memberCount: number
): string | undefined {
  if (collapsed) return undefined;
  if (isLoading) return 'MEMBERS';
  return `MEMBERS (${String(memberCount)})`;
}

interface ComputePanelPropsInput {
  isMobile: boolean;
  collapsed: boolean;
  isLoading: boolean;
  memberCount: number;
  memberSidebarOpen: boolean;
  mobileMemberSidebarOpen: boolean;
  setMemberSidebarOpen: (open: boolean) => void;
  setMobileMemberSidebarOpen: (open: boolean) => void;
}

function computeMemberSidebarPanelProps(
  input: Readonly<ComputePanelPropsInput>
): MemberSidebarPanelConfig {
  return {
    open: input.isMobile ? input.mobileMemberSidebarOpen : input.memberSidebarOpen,
    onOpenChange: input.isMobile ? input.setMobileMemberSidebarOpen : input.setMemberSidebarOpen,
    onClose: input.isMobile
      ? () => {
          input.setMobileMemberSidebarOpen(false);
        }
      : () => {
          input.setMemberSidebarOpen(!input.memberSidebarOpen);
        },
    headerTitle: computeHeaderTitle(input.collapsed, input.isLoading, input.memberCount),
  };
}

function MemberSidebarLoadingContent({
  collapsed,
}: Readonly<{ collapsed: boolean }>): React.JSX.Element {
  if (collapsed) {
    return (
      <Lock
        className="text-muted-foreground h-5 w-5 animate-pulse"
        data-testid={TEST_IDS.decryptingLockIcon}
      />
    );
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Lock className="h-4 w-4 shrink-0" data-testid={TEST_IDS.decryptingLockIcon} />
      Decrypting...
    </span>
  );
}

export function MemberSidebar(props: Readonly<MemberSidebarProps>): React.JSX.Element {
  const {
    memberSidebarOpen,
    setMemberSidebarOpen,
    mobileMemberSidebarOpen,
    setMobileMemberSidebarOpen,
  } = useUIModalsStore(
    useShallow((s) => ({
      memberSidebarOpen: s.memberSidebarOpen,
      setMemberSidebarOpen: s.setMemberSidebarOpen,
      mobileMemberSidebarOpen: s.mobileMemberSidebarOpen,
      setMobileMemberSidebarOpen: s.setMobileMemberSidebarOpen,
    }))
  );
  const isMobile = useIsMobile();
  const collapsed = !isMobile && !memberSidebarOpen;

  const { members, currentUserPrivilege, conversationId } = props;
  const currentUserId = props.currentUserId ?? '';
  const isLoading = !members || !currentUserPrivilege || !conversationId;
  const memberCount = isLoading ? 0 : members.length;

  const panelConfig = computeMemberSidebarPanelProps({
    isMobile,
    collapsed,
    isLoading,
    memberCount,
    memberSidebarOpen,
    mobileMemberSidebarOpen,
    setMemberSidebarOpen,
    setMobileMemberSidebarOpen,
  });

  const sidebar = (
    <SidebarPanel
      side="right"
      open={panelConfig.open}
      onOpenChange={panelConfig.onOpenChange}
      collapsed={collapsed}
      ariaLabel="Members"
      headerIcon={<Users className="h-5 w-5" data-testid={TEST_IDS.memberSidebarHeaderIcon} />}
      headerTitle={panelConfig.headerTitle}
      onClose={panelConfig.onClose}
      footer={
        isLoading ? null : (
          <MemberSidebarFooter
            conversationId={conversationId}
            currentUserId={currentUserId}
            currentUserPrivilege={currentUserPrivilege}
            collapsed={collapsed}
            onBudgetSettingsClick={props.onBudgetSettingsClick}
          />
        )
      }
      testId={TEST_IDS.memberSidebar}
    >
      {isLoading ? (
        <div
          className="flex flex-1 items-center justify-center"
          data-testid={TEST_IDS.decryptingIndicator}
        >
          <MemberSidebarLoadingContent collapsed={collapsed} />
        </div>
      ) : (
        <MemberSidebarBody
          {...buildMemberSidebarBodyProps({
            props,
            members,
            currentUserId,
            currentUserPrivilege,
            conversationId,
            collapsed,
          })}
        />
      )}
    </SidebarPanel>
  );

  if (!isMobile) {
    const portalTarget = document.querySelector('#right-sidebar-portal');
    if (portalTarget) {
      return createPortal(sidebar, portalTarget) as React.JSX.Element;
    }
  }

  return sidebar;
}
