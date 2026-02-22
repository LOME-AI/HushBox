import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  IconButton,
  Input,
  Separator,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@hushbox/ui';
import {
  canManageLinks,
  effectiveBudgetCents,
  normalizeUsername,
  displayUsername,
} from '@hushbox/shared';
import {
  Plus,
  Link as LinkIcon,
  Lock,
  MoreVertical,
  LogOut,
  Pencil,
  Search,
  UserMinus,
  Users,
  Shield,
  DollarSign,
  Trash2,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useConversationBudgets } from '@/hooks/use-conversation-budgets';
import { SidebarPanel } from '@/components/shared/sidebar-panel';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';
import { LeaveConfirmationModal } from './leave-confirmation-modal';
import { ConfirmationModal } from '@/components/shared/confirmation-modal';

interface MemberSidebarProps {
  members?:
    | {
        id: string;
        userId: string;
        username: string;
        privilege: string;
      }[]
    | undefined;
  links?:
    | {
        id: string;
        displayName: string | null;
        privilege: string;
        createdAt: string;
      }[]
    | undefined;
  onlineMemberIds?: Set<string> | undefined;
  currentUserId?: string | undefined;
  currentUserPrivilege?: string | undefined;
  conversationId?: string | undefined;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  onRevokeLinkClick?: ((linkId: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onBudgetSettingsClick?: (() => void) | undefined;
  onLeaveClick?: (() => void) | undefined;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

interface AdminActionButtonsProps {
  collapsed: boolean;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

function AdminActionButtons({
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
        testId="new-member-button"
      />
      <SidebarActionButton
        icon={<LinkIcon className="h-4 w-4" />}
        label="Invite via Link"
        onClick={() => onInviteLink?.()}
        {...(collapsed && { collapsed: true })}
        testId="invite-link-button"
      />
    </>
  );
}

interface MemberAvatarProps {
  initial: string;
  isOnline: boolean;
  size: 'sm' | 'md';
  testIdPrefix: string;
  entityId: string;
}

function MemberAvatar({
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
          data-testid={`${testIdPrefix}-online-${entityId}`}
          className="ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-green-500 ring-2"
        />
      )}
    </div>
  );
}

const PRIVILEGE_ORDER = ['owner', 'admin', 'write', 'read'] as const;

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
        data-testid="decrypting-lock-icon"
      />
    );
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Lock className="h-4 w-4 shrink-0" data-testid="decrypting-lock-icon" />
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
  } = useUIModalsStore();
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
      headerIcon={<Users className="h-5 w-5" data-testid="member-sidebar-header-icon" />}
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
      testId="member-sidebar"
    >
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center" data-testid="decrypting-indicator">
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

interface MemberSidebarBodyProps {
  members: {
    id: string;
    userId: string;
    username: string;
    privilege: string;
  }[];
  links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  }[];
  onlineMemberIds: Set<string>;
  currentUserId: string;
  currentUserPrivilege: string;
  conversationId: string;
  collapsed: boolean;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  onRevokeLinkClick?: ((linkId: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onBudgetSettingsClick?: (() => void) | undefined;
  onLeaveClick?: (() => void) | undefined;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

function MemberSidebarBody({
  members,
  links,
  onlineMemberIds,
  currentUserId,
  currentUserPrivilege,
  onRemoveMember,
  onChangePrivilege,
  onRevokeLinkClick,
  onSaveLinkName,
  onChangeLinkPrivilege,
  onAddMember,
  onInviteLink,
  onLeaveClick,
  collapsed,
}: Readonly<MemberSidebarBodyProps>): React.JSX.Element {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [leaveModalOpen, setLeaveModalOpen] = React.useState(false);
  const [removeMemberTarget, setRemoveMemberTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [revokeLinkTarget, setRevokeLinkTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const isAdmin = canManageLinks(currentUserPrivilege);

  const filteredMembers = React.useMemo(() => {
    if (searchQuery.trim() === '') return members;
    const normalizedQuery = normalizeUsername(searchQuery);
    return members.filter((m) => m.username.includes(normalizedQuery));
  }, [members, searchQuery]);

  const membersByPrivilege = React.useMemo(() => {
    const grouped: Record<string, typeof filteredMembers> = {};
    for (const privilege of PRIVILEGE_ORDER) {
      const matching = filteredMembers.filter((m) => m.privilege === privilege);
      if (matching.length > 0) {
        grouped[privilege] = matching;
      }
    }
    return grouped;
  }, [filteredMembers]);

  const filteredLinks = React.useMemo(() => {
    if (searchQuery.trim() === '') return links;
    const query = searchQuery.toLowerCase();
    return links.filter((l) => (l.displayName ?? '').toLowerCase().includes(query));
  }, [links, searchQuery]);

  const linksByPrivilege = React.useMemo(() => {
    const grouped: Record<string, typeof filteredLinks> = {};
    for (const privilege of PRIVILEGE_ORDER) {
      const matching = filteredLinks.filter((l) => l.privilege === privilege);
      if (matching.length > 0) {
        grouped[privilege] = matching;
      }
    }
    return grouped;
  }, [filteredLinks]);

  const handleRequestRemove = React.useCallback(
    (memberId: string): void => {
      const member = members.find((m) => m.id === memberId);
      setRemoveMemberTarget({
        id: memberId,
        name: member ? displayUsername(member.username) : 'this member',
      });
    },
    [members]
  );

  const handleRequestRevoke = React.useCallback((linkId: string, displayName: string): void => {
    setRevokeLinkTarget({ id: linkId, name: displayName });
  }, []);

  if (collapsed) {
    return (
      <div
        data-testid="member-sidebar-content"
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto"
      >
        {isAdmin && (
          <AdminActionButtons collapsed onAddMember={onAddMember} onInviteLink={onInviteLink} />
        )}
        <Separator className="bg-sidebar-border w-full" />
        {members.slice(0, 8).map((member) => (
          <div key={member.id} data-testid={`member-avatar-${member.id}`}>
            <MemberAvatar
              initial={displayUsername(member.username).charAt(0)}
              isOnline={onlineMemberIds.has(member.userId)}
              size="sm"
              testIdPrefix="member-avatar"
              entityId={member.id}
            />
          </div>
        ))}
        {members.length > 8 && (
          <span data-testid="member-overflow-count" className="text-muted-foreground text-xs">
            +{members.length - 8}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="member-sidebar-content"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Action buttons */}
      {isAdmin && (
        <div className="mb-3 flex flex-col gap-2">
          <AdminActionButtons
            collapsed={false}
            onAddMember={onAddMember}
            onInviteLink={onInviteLink}
          />
        </div>
      )}

      {/* Search */}
      <div className="mb-3">
        <Input
          icon={<Search className="h-4 w-4" />}
          data-testid="member-search-input"
          label="Search members"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
          }}
        />
      </div>

      <Separator className="bg-sidebar-border mb-3" />

      {/* Scrollable member/link list grouped by privilege */}
      <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto">
        {PRIVILEGE_ORDER.map((privilege) => {
          const memberGroup = membersByPrivilege[privilege];
          const linkGroup = linksByPrivilege[privilege];
          if (!memberGroup && !linkGroup) return null;

          return (
            <div key={privilege} data-testid={`member-section-${privilege}`} className="mb-4">
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                {privilege}
              </h3>
              {memberGroup?.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  isCurrentUser={member.userId === currentUserId}
                  isOnline={onlineMemberIds.has(member.userId)}
                  isAdmin={isAdmin}
                  onRemoveMember={handleRequestRemove}
                  onChangePrivilege={onChangePrivilege}
                  onLeaveClick={() => {
                    setLeaveModalOpen(true);
                  }}
                />
              ))}
              {linkGroup?.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  index={links.indexOf(link)}
                  isAdmin={isAdmin}
                  onChangeLinkPrivilege={onChangeLinkPrivilege}
                  onSaveLinkName={onSaveLinkName}
                  onRequestRevoke={handleRequestRevoke}
                />
              ))}
            </div>
          );
        })}
      </div>

      <LeaveConfirmationModal
        open={leaveModalOpen}
        onOpenChange={setLeaveModalOpen}
        isOwner={currentUserPrivilege === 'owner'}
        onConfirm={() => onLeaveClick?.()}
      />
      <ConfirmationModal
        open={removeMemberTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null);
        }}
        title={`Remove ${removeMemberTarget?.name ?? ''}?`}
        warning="This member will lose access to the conversation."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removeMemberTarget) onRemoveMember?.(removeMemberTarget.id);
          setRemoveMemberTarget(null);
        }}
        ariaLabel="Remove Member"
        testIdPrefix="remove-member"
      />
      <ConfirmationModal
        open={revokeLinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeLinkTarget(null);
        }}
        title={`Revoke ${revokeLinkTarget?.name ?? ''}?`}
        warning="Anyone with this link will lose access to the conversation."
        confirmLabel="Revoke"
        onConfirm={() => {
          if (revokeLinkTarget) onRevokeLinkClick?.(revokeLinkTarget.id);
          setRevokeLinkTarget(null);
        }}
        ariaLabel="Revoke Link"
        testIdPrefix="revoke-link"
      />
    </div>
  );
}

interface BudgetData {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: {
    memberId: string;
    userId: string;
    /** '0.00' when no member_budgets row exists. */
    budget: string;
    spent: string;
  }[];
  ownerBalanceDollars: number;
}

function computeBudgetSublabel(
  data: BudgetData,
  currentUserId: string,
  currentUserPrivilege: string
): string {
  const memberBudget = data.memberBudgets.find((mb) => mb.userId === currentUserId);
  const spentDollars = Number.parseFloat(memberBudget?.spent ?? '0');

  const budgetDollars =
    currentUserPrivilege === 'owner'
      ? data.ownerBalanceDollars
      : effectiveBudgetCents({
          conversationRemainingCents:
            Number.parseFloat(data.conversationBudget) * 100 -
            Number.parseFloat(data.totalSpent) * 100,
          memberRemainingCents:
            memberBudget === undefined
              ? 0
              : Number.parseFloat(memberBudget.budget) * 100 -
                Number.parseFloat(memberBudget.spent) * 100,
          ownerRemainingCents: data.ownerBalanceDollars * 100,
        }) / 100;

  const spent = `$${spentDollars.toFixed(2)}`;
  const budget = `$${budgetDollars.toFixed(2)}`;
  return `${spent} spent / ${budget} budget`;
}

interface MemberSidebarFooterProps {
  conversationId: string;
  currentUserId: string;
  currentUserPrivilege: string;
  collapsed: boolean;
  onBudgetSettingsClick?: (() => void) | undefined;
}

function MemberSidebarFooter({
  conversationId,
  currentUserId,
  currentUserPrivilege,
  collapsed,
  onBudgetSettingsClick,
}: Readonly<MemberSidebarFooterProps>): React.JSX.Element {
  const isAdmin = canManageLinks(currentUserPrivilege);
  const { data } = useConversationBudgets(conversationId) as { data: BudgetData | undefined };

  const sublabel =
    data === undefined
      ? undefined
      : computeBudgetSublabel(data, currentUserId, currentUserPrivilege);

  return (
    <SidebarFooterBase
      icon={<DollarSign className="size-4" />}
      label={isAdmin ? 'Budget Settings' : 'Your Budget'}
      sublabel={sublabel}
      onClick={onBudgetSettingsClick}
      collapsed={collapsed}
      testId="member-budget"
    />
  );
}

interface MemberRowProps {
  member: {
    id: string;
    userId: string;
    username: string;
    privilege: string;
  };
  isCurrentUser: boolean;
  isOnline: boolean;
  isAdmin: boolean;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  onLeaveClick?: (() => void) | undefined;
}

function MemberRow({
  member,
  isCurrentUser,
  isOnline,
  isAdmin,
  onRemoveMember,
  onChangePrivilege,
  onLeaveClick,
}: Readonly<MemberRowProps>): React.JSX.Element {
  const showActions = isCurrentUser || (isAdmin && !isCurrentUser);

  return (
    <div
      data-testid={`member-item-${member.id}`}
      className="flex items-center justify-between py-2"
    >
      <div className="flex items-center gap-2">
        <MemberAvatar
          initial={displayUsername(member.username).charAt(0)}
          isOnline={isOnline}
          size="md"
          testIdPrefix="member"
          entityId={member.id}
        />
        <span className="text-sm">
          {displayUsername(member.username)}
          {isCurrentUser && (
            <span data-testid="member-you-badge" className="text-muted-foreground ml-1">
              (you)
            </span>
          )}
        </span>
      </div>
      {showActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton data-testid={`member-actions-${member.id}`}>
              <MoreVertical className="size-4" />
              <span className="sr-only">More options</span>
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isCurrentUser ? (
              <DropdownMenuItem
                data-testid="member-leave-action"
                className="text-destructive"
                onSelect={() => onLeaveClick?.()}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Leave
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid={`member-change-privilege-${member.id}`}>
                    <Shield className="mr-2 h-4 w-4" />
                    Change Privilege
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {PRIVILEGE_ORDER.filter((p) => p !== 'owner').map((priv) => (
                      <DropdownMenuItem
                        key={priv}
                        data-testid={`privilege-option-${member.id}-${priv}`}
                        onSelect={() => onChangePrivilege?.(member.id, priv)}
                      >
                        {priv}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  data-testid={`member-remove-action-${member.id}`}
                  className="text-destructive"
                  onSelect={() => onRemoveMember?.(member.id)}
                >
                  <UserMinus className="mr-2 h-4 w-4" />
                  Remove Member
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const LINK_PRIVILEGE_OPTIONS = ['read', 'write'] as const;

interface LinkRowProps {
  link: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  };
  index: number;
  isAdmin: boolean;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onRequestRevoke?: ((linkId: string, displayName: string) => void) | undefined;
}

function LinkRow({
  link,
  index,
  isAdmin,
  onChangeLinkPrivilege,
  onSaveLinkName,
  onRequestRevoke,
}: Readonly<LinkRowProps>): React.JSX.Element {
  const displayName = link.displayName ?? `Guest Link #${String(index + 1)}`;
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(displayName);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  const handleStartEdit = (): void => {
    setEditValue(displayName);
    setIsEditing(true);
  };

  const handleSave = (): void => {
    if (editValue.trim() !== '') {
      onSaveLinkName?.(link.id, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return (
    <div data-testid={`link-item-${link.id}`} className="flex items-center justify-between py-2">
      <div className="flex min-w-0 items-center gap-2">
        <div data-testid="link-icon-container" className="flex size-8 items-center justify-center">
          <LinkIcon className="text-muted-foreground size-4" />
        </div>
        {isEditing ? (
          <input
            ref={inputRef}
            data-testid={`link-name-input-${link.id}`}
            className="bg-background border-input min-w-0 flex-1 rounded border px-1 py-0.5 text-sm"
            value={editValue}
            onChange={(e) => {
              setEditValue(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
          />
        ) : (
          <span className="text-sm">{displayName}</span>
        )}
      </div>
      {isAdmin && !isEditing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton data-testid={`link-actions-${link.id}`}>
              <MoreVertical className="size-4" />
              <span className="sr-only">More options</span>
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid={`link-change-privilege-${link.id}`}>
                <Shield className="mr-2 h-4 w-4" />
                Change Privilege
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {LINK_PRIVILEGE_OPTIONS.map((priv) => (
                  <DropdownMenuItem
                    key={priv}
                    data-testid={`link-privilege-option-${link.id}-${priv}`}
                    onSelect={() => onChangeLinkPrivilege?.(link.id, priv)}
                  >
                    {priv}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              data-testid={`link-change-name-${link.id}`}
              onSelect={handleStartEdit}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Change Name
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={`link-revoke-action-${link.id}`}
              className="text-destructive"
              onSelect={() => onRequestRevoke?.(link.id, displayName)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Revoke Link
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
