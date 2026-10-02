import * as React from 'react';
import { Lock } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useFormFactor } from '@hushbox/ui/platform';
import { TEST_IDS } from '@hushbox/shared';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useRightPane } from '@/stores/ui/right-pane';
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

const PANE_ID = 'members';

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

/**
 * Keeps the members pane in step with the open flags its openers write: a press that sets the
 * flag for the viewport's band opens the pane, and every way the pane closes, another pane
 * taking the slot included, clears both flags so the next press opens it again. A right pane
 * is never restored on load, so a flag saved from an earlier visit opens nothing and is
 * cleared, which keeps the first press an opening one.
 */
function useMembersPaneFlags(): { clearFlags: () => void } {
  const {
    memberSidebarOpen,
    mobileMemberSidebarOpen,
    setMemberSidebarOpen,
    setMobileMemberSidebarOpen,
  } = useUIModalsStore(
    useShallow((s) => ({
      memberSidebarOpen: s.memberSidebarOpen,
      mobileMemberSidebarOpen: s.mobileMemberSidebarOpen,
      setMemberSidebarOpen: s.setMemberSidebarOpen,
      setMobileMemberSidebarOpen: s.setMobileMemberSidebarOpen,
    }))
  );
  const isPhone = useFormFactor().band === 'phone';
  const wantsOpen = isPhone ? mobileMemberSidebarOpen : memberSidebarOpen;

  const clearFlags = React.useCallback((): void => {
    setMemberSidebarOpen(false);
    setMobileMemberSidebarOpen(false);
  }, [setMemberSidebarOpen, setMobileMemberSidebarOpen]);

  React.useEffect(() => {
    const flags = useUIModalsStore.getState();
    if (flags.memberSidebarOpen || flags.mobileMemberSidebarOpen) clearFlags();
  }, [clearFlags]);

  // Only a change of the flag moves the pane; the value it mounts with is a saved one.
  const lastWantsOpen = React.useRef(wantsOpen);
  React.useEffect(() => {
    if (lastWantsOpen.current === wantsOpen) return;
    lastWantsOpen.current = wantsOpen;
    const pane = useRightPane.getState();
    if (wantsOpen) pane.open(PANE_ID);
    else if (pane.active === PANE_ID) pane.close();
  }, [wantsOpen]);

  React.useEffect(
    () =>
      useRightPane.subscribe((state, previous) => {
        if (previous.active === PANE_ID && state.active !== PANE_ID) clearFlags();
      }),
    [clearFlags]
  );

  return { clearFlags };
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
  const { clearFlags } = useMembersPaneFlags();

  const { members, currentUserPrivilege, conversationId } = props;
  const currentUserId = props.currentUserId ?? '';
  // The budgets route refuses a link guest outright, so a guest asks nothing, as the foot does.
  const isLinkGuest = useLinkGuestActive();
  const { data: budgets } = useConversationBudgets(
    isLinkGuest || conversationId === undefined ? null : conversationId
  );
  const isLoading = !members || !currentUserPrivilege || !conversationId;

  return (
    <RightPane
      id={PANE_ID}
      title="Members"
      {...(isLoading ? {} : { titleAside: `· ${String(members.length)}` })}
      width="20rem"
      surface="sidebar"
      head="plain"
      phone="fullscreen"
      onClose={clearFlags}
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
