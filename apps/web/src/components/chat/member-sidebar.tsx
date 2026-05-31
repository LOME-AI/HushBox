import * as React from 'react';
import { createPortal } from 'react-dom';
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
import {
  IconButton,
  Input,
  Separator,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  SidebarPanel,
  useAsyncAction,
  useIsMobile,
} from '@hushbox/ui';
import {
  canManageLinks,
  effectiveBudgetCents,
  normalizeUsername,
  displayUsername,
} from '@hushbox/shared';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useConversationBudgets } from '@/hooks/use-conversation-budgets';
import { SidebarActionButton } from '@/components/shared/sidebar-action-button';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';
import { ConfirmationModal } from '@/components/shared/confirmation-modal';
import { LeaveConfirmationModal } from './leave-confirmation-modal';

interface MemberEntry {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface LinkEntry {
  id: string;
  displayName: string | null;
  privilege: string;
  createdAt: string;
}

interface MemberSidebarCallbacks {
  onRemoveMember?: ((memberId: string) => void | Promise<void>) | undefined;
  onChangePrivilege?:
    | ((memberId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  onRevokeLinkClick?: ((linkId: string) => void | Promise<void>) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void | Promise<void>) | undefined;
  onChangeLinkPrivilege?:
    | ((linkId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  onBudgetSettingsClick?: (() => void) | undefined;
  onLeaveClick?: (() => void | Promise<void>) | undefined;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

interface MemberSidebarProps extends MemberSidebarCallbacks {
  members?: MemberEntry[] | undefined;
  links?: LinkEntry[] | undefined;
  onlineMemberIds?: Set<string> | undefined;
  currentUserId?: string | undefined;
  currentUserLinkId?: string | null | undefined;
  currentUserPrivilege?: string | undefined;
  conversationId?: string | undefined;
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

function groupByPrivilege<T extends { privilege: string }>(items: T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const privilege of PRIVILEGE_ORDER) {
    const matching = items.filter((item) => item.privilege === privilege);
    if (matching.length > 0) {
      grouped[privilege] = matching;
    }
  }
  return grouped;
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

interface MemberSidebarBodyProps extends MemberSidebarCallbacks {
  members: MemberEntry[];
  links: LinkEntry[];
  onlineMemberIds: Set<string>;
  currentUserId: string;
  currentUserLinkId: string | null;
  currentUserPrivilege: string;
  conversationId: string;
  collapsed: boolean;
}

function MemberSidebarBody({
  members,
  links,
  onlineMemberIds,
  currentUserId,
  currentUserLinkId,
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
  conversationId,
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

  // Reset transient UI state when switching conversations. Replaces the
  // parent's `key={conversationId}` remount, which (along with the
  // MessageList remount) was the source of the welcome → conversation flash.
  const previousConversationIdRef = React.useRef<string>(conversationId);
  React.useEffect(() => {
    if (previousConversationIdRef.current === conversationId) return;
    previousConversationIdRef.current = conversationId;
    setSearchQuery('');
    setLeaveModalOpen(false);
    setRemoveMemberTarget(null);
    setRevokeLinkTarget(null);
  }, [conversationId]);

  // Inline-control mutations (privilege select-on-change, name inline-edit,
  // link-privilege select-on-change) have no modal to attach an error to.
  // Wrap each in useAsyncAction with fallback='toast' so failures still
  // surface visibly instead of being silently swallowed by the void caller.
  const changePrivilegeAction = useAsyncAction({ fallback: 'toast' });
  const saveLinkNameAction = useAsyncAction({ fallback: 'toast' });
  const changeLinkPrivilegeAction = useAsyncAction({ fallback: 'toast' });

  const handleChangePrivilege = React.useCallback(
    (memberId: string, newPrivilege: string): void => {
      void changePrivilegeAction.run(async () => {
        const maybe = onChangePrivilege?.(memberId, newPrivilege);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onChangePrivilege, changePrivilegeAction]
  );

  const handleSaveLinkName = React.useCallback(
    (linkId: string, newName: string): void => {
      void saveLinkNameAction.run(async () => {
        const maybe = onSaveLinkName?.(linkId, newName);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onSaveLinkName, saveLinkNameAction]
  );

  const handleChangeLinkPrivilege = React.useCallback(
    (linkId: string, newPrivilege: string): void => {
      void changeLinkPrivilegeAction.run(async () => {
        const maybe = onChangeLinkPrivilege?.(linkId, newPrivilege);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onChangeLinkPrivilege, changeLinkPrivilegeAction]
  );

  const filteredMembers = React.useMemo(() => {
    if (searchQuery.trim() === '') return members;
    const normalizedQuery = normalizeUsername(searchQuery);
    return members.filter((m) => m.username.includes(normalizedQuery));
  }, [members, searchQuery]);

  const membersByPrivilege = React.useMemo(
    () => groupByPrivilege(filteredMembers),
    [filteredMembers]
  );

  const filteredLinks = React.useMemo(() => {
    if (searchQuery.trim() === '') return links;
    const query = searchQuery.toLowerCase();
    return links.filter((l) => (l.displayName ?? '').toLowerCase().includes(query));
  }, [links, searchQuery]);

  const linksByPrivilege = React.useMemo(() => groupByPrivilege(filteredLinks), [filteredLinks]);

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
        className="scrollbar-hide flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto"
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
      {isAdmin && (
        <div className="mb-3 flex flex-col gap-2">
          <AdminActionButtons
            collapsed={false}
            onAddMember={onAddMember}
            onInviteLink={onInviteLink}
          />
        </div>
      )}

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
                  onChangePrivilege={
                    onChangePrivilege === undefined ? undefined : handleChangePrivilege
                  }
                  onLeaveClick={
                    onLeaveClick === undefined
                      ? undefined
                      : () => {
                          setLeaveModalOpen(true);
                        }
                  }
                />
              ))}
              {linkGroup?.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  index={links.indexOf(link)}
                  isCurrentLink={currentUserLinkId !== null && link.id === currentUserLinkId}
                  isAdmin={isAdmin}
                  onChangeLinkPrivilege={
                    onChangeLinkPrivilege === undefined ? undefined : handleChangeLinkPrivilege
                  }
                  onSaveLinkName={onSaveLinkName === undefined ? undefined : handleSaveLinkName}
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
        onConfirm={async () => {
          // Propagate the Promise so LeaveConfirmationModal's ActionModal
          // can hold the inline-error region open on failure (instead of
          // closing optimistically and losing the rotation result).
          await onLeaveClick?.();
        }}
      />
      <ConfirmationModal
        open={removeMemberTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null);
        }}
        title={`Remove ${removeMemberTarget?.name ?? ''}?`}
        warning="This member will lose access to the conversation."
        confirmLabel="Remove"
        onConfirm={async () => {
          // Awaiting onRemoveMember surfaces its Promise to ConfirmationModal's
          // ActionModal. On success, both the explicit setState below and the
          // modal's own onOpenChange close the overlay; on failure, the throw
          // skips setState and the modal stays open with the inline error.
          if (removeMemberTarget) await onRemoveMember?.(removeMemberTarget.id);
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
        onConfirm={async () => {
          if (revokeLinkTarget) await onRevokeLinkClick?.(revokeLinkTarget.id);
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
    userId: string | null;
    linkId: string | null;
    /** '0.00' when no member_budgets row exists. */
    budget: string;
    spent: string;
  }[];
  ownerBalanceDollars: number;
}

/** @internal Exported for testing. */
export function computeBudgetSublabel(
  data: BudgetData,
  currentUserId: string,
  currentUserPrivilege: string
): string {
  const memberBudget = data.memberBudgets.find(
    (mb) =>
      mb.userId === currentUserId || mb.linkId === currentUserId || mb.memberId === currentUserId
  );
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
  onLeaveClick?: (() => void | Promise<void>) | undefined;
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
  const showActions = (isCurrentUser && onLeaveClick !== undefined) || (isAdmin && !isCurrentUser);

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
            <IconButton aria-label="More options" data-testid={`member-actions-${member.id}`}>
              <MoreVertical className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isCurrentUser ? (
              <DropdownMenuItem
                data-testid="member-leave-action"
                className="text-destructive"
                onSelect={() => {
                  void onLeaveClick?.();
                }}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Leave
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuLabel
                  data-testid={`member-change-privilege-${member.id}`}
                  className="flex items-center gap-2 text-xs font-normal"
                >
                  <Shield className="h-4 w-4" />
                  Change privilege
                </DropdownMenuLabel>
                {/*
                  Flattened radio group instead of a DropdownMenuSub. The Sub
                  flow loses pointer events on Firefox (and on touch devices)
                  because the SubContent's DismissableLayer can intercept the
                  pointerdown and unmount the SubContent before the click
                  reaches the inner item. RadioGroup inside the same content
                  has no portal-within-portal, so the click path is reliable
                  cross-browser. Each radio's value is the literal privilege
                  string; the onValueChange handler invokes the same callback
                  as the previous DropdownMenuItem.onSelect did.
                */}
                <DropdownMenuRadioGroup
                  value={member.privilege}
                  onValueChange={(next) => onChangePrivilege?.(member.id, next)}
                >
                  {PRIVILEGE_ORDER.filter((p) => p !== 'owner').map((priv) => (
                    <DropdownMenuRadioItem
                      key={priv}
                      value={priv}
                      data-testid={`privilege-option-${member.id}-${priv}`}
                    >
                      {priv}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
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
  isCurrentLink: boolean;
  isAdmin: boolean;
  onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  onRequestRevoke?: ((linkId: string, displayName: string) => void) | undefined;
}

function LinkRow({
  link,
  index,
  isCurrentLink,
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
          <span className="text-sm">
            {displayName}
            {isCurrentLink && (
              <span data-testid="link-you-badge" className="text-muted-foreground ml-1">
                (you)
              </span>
            )}
          </span>
        )}
      </div>
      {isAdmin && !isEditing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label="More options" data-testid={`link-actions-${link.id}`}>
              <MoreVertical className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel
              data-testid={`link-change-privilege-${link.id}`}
              className="flex items-center gap-2 text-xs font-normal"
            >
              <Shield className="h-4 w-4" />
              Change privilege
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={link.privilege}
              onValueChange={(next) => onChangeLinkPrivilege?.(link.id, next)}
            >
              {LINK_PRIVILEGE_OPTIONS.map((priv) => (
                <DropdownMenuRadioItem
                  key={priv}
                  value={priv}
                  data-testid={`link-privilege-option-${link.id}-${priv}`}
                >
                  {priv}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
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
