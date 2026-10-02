import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { centsToNanoUsd, MEMBER_PRIVILEGES, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MemberSidebar } from '@/components/chat/member/member-sidebar';
import { RightPaneHostContext } from '@/components/shared/right-pane';
import { useSidebarRail } from '@/hooks/ui/use-sidebar-rail';
import { clearLinkGuestAuth, setLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIStore } from '@/stores/ui/ui';
import type { RenderResult } from '@testing-library/react';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';

const { mockUseConversationBudgets, mockUseConversationMembers, mockUseConversationLinks } =
  vi.hoisted(() => ({
    mockUseConversationBudgets: vi.fn(),
    mockUseConversationMembers: vi.fn(() => ({ data: undefined })),
    mockUseConversationLinks: vi.fn(() => ({ data: undefined })),
  }));

vi.mock('@/hooks/billing/use-conversation-budgets', () => ({
  useConversationBudgets: mockUseConversationBudgets,
}));

// The owner's budget foot names funded link seats from the roster and links reads.
vi.mock('@/hooks/realtime/use-conversation-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/realtime/use-conversation-members')>()),
  useConversationMembers: mockUseConversationMembers,
}));

vi.mock('@/hooks/realtime/use-conversation-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/realtime/use-conversation-links')>()),
  useConversationLinks: mockUseConversationLinks,
}));

/** The sidebar's fold, read through the hook every sidebar part reads. */
function RailProbe(): React.JSX.Element {
  return <div data-rail-probe={String(useSidebarRail())} />;
}

/** The header's facepile press: the phone flag below 768, the desktop toggle from 768. */
function pressFacepile(): void {
  const store = useUIModalsStore.getState();
  if (globalThis.matchMedia('(max-width: 767px)').matches) {
    store.setMobileMemberSidebarOpen(!store.mobileMemberSidebarOpen);
  } else {
    store.toggleMemberSidebar();
  }
}

/** Stands in for the app shell: an opener, the content, and the right-pane slot. */
function Shell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  return (
    <RightPaneHostContext value={host}>
      <RailProbe />
      <button type="button" data-opener-under-test="" onClick={pressFacepile}>
        Members
      </button>
      <main>{children}</main>
      <div ref={setHost} data-slot-under-test="" />
    </RightPaneHostContext>
  );
}

function opener(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-opener-under-test]');
  if (element === null) throw new Error('the shell rendered no opener');
  return element;
}

/** Renders the pane with nothing open. */
function renderClosed(ui: React.ReactElement): RenderResult {
  return render(ui, { wrapper: Shell });
}

/** Renders the pane and opens it the way the header does: one press of the opener. */
function renderPane(ui: React.ReactElement): RenderResult {
  const result = renderClosed(ui);
  fireEvent.click(opener());
  return result;
}

function slot(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot-under-test]');
  if (element === null) throw new Error('the shell rendered no slot');
  return element;
}

function railShown(): string | undefined {
  return document.querySelector<HTMLElement>('[data-rail-probe]')?.dataset['railProbe'];
}

const realMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, where the pane takes its full-screen phone form. */
function stubPhoneWidth(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

function makeMembers(): {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}[] {
  return [
    { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    { id: 'm2', userId: 'u2', username: 'bob', privilege: 'admin' },
    { id: 'm3', userId: 'u3', username: 'charlie', privilege: 'write' },
    { id: 'm4', userId: 'u4', username: 'dave', privilege: 'read' },
  ];
}

function makeLinks(): {
  id: string;
  displayName: string | null;
  privilege: string;
  createdAt: string;
  memberId: string | null;
}[] {
  return [
    {
      id: 'link1',
      displayName: 'Dave',
      privilege: 'read',
      createdAt: isoAt(TEST_DAY_START + DAY_MS),
      memberId: null,
    },
    {
      id: 'link2',
      displayName: null,
      privilege: 'write',
      createdAt: isoAt(TEST_DAY_START),
      memberId: null,
    },
  ];
}

const defaultProps = {
  members: makeMembers(),
  links: makeLinks(),
  onlineMemberIds: new Set(['u1', 'u2']),
  currentUserId: 'u1',
  currentUserPrivilege: 'owner' as const,
  conversationId: 'conv-123',
  onRemoveMember: vi.fn(),
  onChangePrivilege: vi.fn(),
  onRevokeLinkClick: vi.fn(),
  onSaveLinkName: vi.fn(),
  onChangeLinkPrivilege: vi.fn(),
  onBudgetSettingsClick: vi.fn(),
  onLeaveClick: vi.fn(),
  onAddMember: vi.fn(),
  onInviteLink: vi.fn(),
};

describe('MemberSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConversationBudgets.mockReturnValue({ data: undefined, isLoading: false });
    useUIModalsStore.setState({ memberSidebarOpen: false, mobileMemberSidebarOpen: false });
    useRightPane.setState({ active: null });
    useUIStore.setState({ sidebarOpen: true });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: realMatchMedia });
    // Clearing notifies the still-mounted pane, so it settles inside act.
    act(() => {
      clearLinkGuestAuth();
    });
  });

  describe('head', () => {
    it('names the pane Members with the member count muted beside it', () => {
      renderPane(<MemberSidebar {...defaultProps} members={makeMembers().slice(0, 3)} />);

      const heading = within(slot()).getByRole('heading', { name: 'Members · 3' });
      expect(within(heading).getByText('· 3')).toHaveClass('text-muted-foreground');
    });

    it('draws no header icon', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.memberSidebarHeaderIcon)).not.toBeInTheDocument();
    });

    it('names its close button Close members', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(within(slot()).getByRole('button', { name: 'Close members' })).toBeInTheDocument();
    });

    it('clears both open flags when its close button is pressed', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: 'Close members' }));

      expect(useUIModalsStore.getState()).toMatchObject({
        memberSidebarOpen: false,
        mobileMemberSidebarOpen: false,
      });
    });

    it('leaves the slot when its close button is pressed', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: 'Close members' }));

      expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
    });
  });

  describe('where the pane draws', () => {
    it('draws nothing at 1024 while it is closed', () => {
      renderClosed(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.memberSidebarContent)).not.toBeInTheDocument();
    });

    it('leaves the sidebar expanded at 1024 while it is closed', () => {
      renderClosed(<MemberSidebar {...defaultProps} />);

      expect(railShown()).toBe('false');
    });

    it('docks in the shell slot at 1024 while it is open', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const pane = within(slot()).getByRole('complementary', { name: /Members/ });
      expect(pane).toHaveAttribute('data-testid', TEST_IDS.memberSidebar);
    });

    it('folds the sidebar to its rail at 1024 while it is open', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(railShown()).toBe('true');
    });

    it('fills the screen at 390', () => {
      stubPhoneWidth();

      renderPane(<MemberSidebar {...defaultProps} />);

      const dialog = screen.getByRole('dialog', { name: /Members/ });
      expect(within(dialog).getByTestId(TEST_IDS.memberSidebar)).toBeInTheDocument();
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    });

    it('stays closed at 390 when only the desktop flag is set', () => {
      stubPhoneWidth();
      renderClosed(<MemberSidebar {...defaultProps} />);

      act(() => {
        useUIModalsStore.getState().setMemberSidebarOpen(true);
      });

      expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
    });

    it('closes the full-screen form on Escape', async () => {
      const user = userEvent.setup();
      stubPhoneWidth();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
      });
      expect(useUIModalsStore.getState().mobileMemberSidebarOpen).toBe(false);
    });

    it('keeps the memberSidebar and memberSidebarContent ids', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.memberSidebar)).toContainElement(
        screen.getByTestId(TEST_IDS.memberSidebarContent)
      );
    });

    it('clears both open flags when another pane takes the slot', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      act(() => {
        useRightPane.getState().open('accessibility');
      });

      expect(useUIModalsStore.getState()).toMatchObject({
        memberSidebarOpen: false,
        mobileMemberSidebarOpen: false,
      });
    });

    it('closes on a second press of the opener', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      fireEvent.click(opener());

      expect(useRightPane.getState().active).toBeNull();
    });

    it('leaves another pane open when its own flag is clear', () => {
      useRightPane.setState({ active: 'accessibility' });

      renderClosed(<MemberSidebar {...defaultProps} />);

      expect(useRightPane.getState().active).toBe('accessibility');
    });
  });

  describe('a reload with the open flag saved', () => {
    beforeEach(() => {
      useUIModalsStore.setState({ memberSidebarOpen: true });
    });

    it('opens no pane', () => {
      renderClosed(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
      expect(useRightPane.getState().active).toBeNull();
    });

    it('leaves focus where the page put it', () => {
      renderClosed(<MemberSidebar {...defaultProps} />);

      expect(document.activeElement).toBe(document.body);
    });

    it('opens the pane on the first press of the opener', async () => {
      const user = userEvent.setup();
      renderClosed(<MemberSidebar {...defaultProps} />);

      await user.click(opener());

      expect(within(slot()).getByTestId(TEST_IDS.memberSidebar)).toBeInTheDocument();
    });

    it('returns focus to the opener on Escape after that press', async () => {
      const user = userEvent.setup();
      renderClosed(<MemberSidebar {...defaultProps} />);
      await user.click(opener());
      expect(within(slot()).getByTestId(TEST_IDS.memberSidebar)).toBeInTheDocument();

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(opener()).toHaveFocus();
      });
      expect(screen.queryByTestId(TEST_IDS.memberSidebar)).not.toBeInTheDocument();
    });
  });

  describe('action buttons', () => {
    it('offers the owner Add Member', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByTestId('new-member-button')).toHaveAccessibleName('Add Member');
    });

    it('renders Invite via Link button when canManageMembers is true', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByTestId('invite-link-button')).toBeInTheDocument();
    });

    it('hides Add Member for non-admin users', () => {
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(screen.queryByTestId('new-member-button')).not.toBeInTheDocument();
    });

    it('hides Invite via Link button for non-admin users', () => {
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(screen.queryByTestId('invite-link-button')).not.toBeInTheDocument();
    });

    it('calls onAddMember when Add Member is pressed', async () => {
      const onAddMember = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onAddMember={onAddMember} />);

      await user.click(screen.getByTestId('new-member-button'));

      expect(onAddMember).toHaveBeenCalledOnce();
    });

    it('calls onInviteLink when Invite via Link button is clicked', async () => {
      const onInviteLink = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onInviteLink={onInviteLink} />);

      await user.click(screen.getByTestId('invite-link-button'));

      expect(onInviteLink).toHaveBeenCalledOnce();
    });
  });

  describe('search', () => {
    it('renders search input', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-search-input')).toBeInTheDocument();
    });

    it('filters members by username (case-insensitive)', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m3')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m4')).not.toBeInTheDocument();
    });

    it('normalizes search query with uppercase letters', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'Ali');

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m2')).not.toBeInTheDocument();
    });

    it('shows all members when search is cleared', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      await user.clear(screen.getByTestId('member-search-input'));

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m2')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m3')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m4')).toBeInTheDocument();
    });
  });

  describe('members list', () => {
    it('lists every member with no privilege sections', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      for (const privilege of MEMBER_PRIVILEGES) {
        expect(
          screen.queryByTestId(TEST_ID_BUILDERS.memberSection(privilege))
        ).not.toBeInTheDocument();
      }
      for (const id of ['m1', 'm2', 'm3', 'm4']) {
        expect(screen.getByTestId(TEST_ID_BUILDERS.memberItem(id))).toBeInTheDocument();
      }
    });

    it('shows (you) badge for current user', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-you-badge')).toBeInTheDocument();
      const aliceItem = screen.getByTestId('member-item-m1');
      expect(aliceItem).toHaveTextContent('(you)');
    });

    it('shows (you) badge for current link guest', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserLinkId="link1" />);

      expect(screen.getByTestId('link-you-badge')).toBeInTheDocument();
      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).toHaveTextContent('(you)');
    });

    it('shows online indicator for online members', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))).toBeInTheDocument();
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm2'))).toBeInTheDocument();
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm3'))
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm4'))
      ).not.toBeInTheDocument();
    });
  });

  describe('member row dropdown menu', () => {
    it('shows three-dots button for current user (Leave action available)', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-actions-m1')).toBeInTheDocument();
    });

    it('shows three-dots button for other members when admin+', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-actions-m2')).toBeInTheDocument();
      expect(screen.getByTestId('member-actions-m3')).toBeInTheDocument();
      expect(screen.getByTestId('member-actions-m4')).toBeInTheDocument();
    });

    it('hides three-dots for other members when user is not admin', () => {
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(screen.getByTestId('member-actions-m3')).toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m4')).not.toBeInTheDocument();
    });

    it('hides three-dots for current user when onLeaveClick is undefined', () => {
      renderPane(
        <MemberSidebar
          {...defaultProps}
          currentUserId="u3"
          currentUserPrivilege="write"
          onLeaveClick={undefined}
        />
      );

      expect(screen.queryByTestId('member-actions-m3')).not.toBeInTheDocument();
    });

    it('shows Leave in current user dropdown', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
    });

    it('opens leave confirmation modal when Leave is selected from dropdown', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
    });

    it('calls onLeaveClick when leave is confirmed from dropdown menu', async () => {
      const onLeaveClick = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onLeaveClick={onLeaveClick} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('leave-confirmation-confirm'));

      expect(onLeaveClick).toHaveBeenCalledOnce();
    });

    it('shows Change Privilege submenu for other members when admin+', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-change-privilege-m2')).toBeInTheDocument();
      });
    });

    it('shows Remove Member action for other members when admin+', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
    });

    it('opens confirmation modal when Remove Member is clicked', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      // Should not call directly — opens modal instead
      expect(onRemoveMember).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId('remove-member-modal')).toBeInTheDocument();
      });
    });

    it('calls onChangePrivilege when a privilege option is selected', async () => {
      const onChangePrivilege = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onChangePrivilege={onChangePrivilege} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      });
      // Flat radio group inside the main dropdown — no sub-menu hop.
      fireEvent.click(screen.getByTestId('privilege-option-m2-write'));

      await waitFor(() => {
        expect(onChangePrivilege).toHaveBeenCalledWith('m2', 'write');
      });
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('does not show owner in privilege options', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('privilege-option-m2-owner')).not.toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-admin')).toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-read')).toBeInTheDocument();
    });
  });

  describe('confirmation modals', () => {
    it('shows confirmation modal when Remove Member is clicked', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-modal')).toBeInTheDocument();
      });
      expect(screen.getByTestId('remove-member-title')).toHaveTextContent('Remove Bob?');
    });

    it('calls onRemoveMember only after confirmation', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      // Not called yet — just opened the modal
      expect(onRemoveMember).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-confirm')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('remove-member-confirm'));

      expect(onRemoveMember).toHaveBeenCalledWith('m2');
    });

    it('does not call onRemoveMember when cancel is clicked', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-cancel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('remove-member-cancel'));

      expect(onRemoveMember).not.toHaveBeenCalled();
    });

    it('shows confirmation modal when Revoke Link is clicked', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-modal')).toBeInTheDocument();
      });
      expect(screen.getByTestId('revoke-link-title')).toHaveTextContent('Revoke Dave?');
    });

    it('calls onRevokeLinkClick only after confirmation', async () => {
      const onRevokeLinkClick = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRevokeLinkClick={onRevokeLinkClick} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      expect(onRevokeLinkClick).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-confirm')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('revoke-link-confirm'));

      expect(onRevokeLinkClick).toHaveBeenCalledWith('link1');
    });

    it('does not call onRevokeLinkClick when cancel is clicked', async () => {
      const onRevokeLinkClick = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRevokeLinkClick={onRevokeLinkClick} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-cancel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('revoke-link-cancel'));

      expect(onRevokeLinkClick).not.toHaveBeenCalled();
    });
  });

  describe('link integration', () => {
    it('lists the invite links after the members, under their own label', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const label = screen.getByRole('heading', { name: 'Invite links · 2' });
      const lastMember = screen.getByTestId(TEST_ID_BUILDERS.memberItem('m4'));
      const firstLink = screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1'));
      expect(lastMember.compareDocumentPosition(label)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(label.compareDocumentPosition(firstLink)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('does not show privilege text next to link names', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).not.toHaveTextContent('(read)');
    });

    it('renders link items with display name', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).toHaveTextContent('Dave');
    });

    it('shows fallback name for links without display name', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link2');
      expect(linkItem).toHaveTextContent('Guest Link #2');
    });

    it('search filters links by display name', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'dave');

      expect(screen.getByTestId('link-item-link1')).toBeInTheDocument();
      expect(screen.queryByTestId('link-item-link2')).not.toBeInTheDocument();
    });

    it('link text aligns with member text (size-8 icon container)', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      const iconContainer = linkItem.querySelector('[data-testid="link-icon-container"]');
      expect(iconContainer).toHaveClass('size-8');
    });
  });

  describe('link dropdown menu', () => {
    it('shows three-dot button for links when admin', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('link-actions-link1')).toBeInTheDocument();
      expect(screen.getByTestId('link-actions-link2')).toBeInTheDocument();
    });

    it('hides three-dot button for links when non-admin', () => {
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(screen.queryByTestId('link-actions-link1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('link-actions-link2')).not.toBeInTheDocument();
    });

    it('shows privilege options for links with read/write options', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-privilege-option-link1-read')).toBeInTheDocument();
      });

      expect(screen.getByTestId('link-privilege-option-link1-write')).toBeInTheDocument();
      expect(screen.queryByTestId('link-privilege-option-link1-admin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('link-privilege-option-link1-owner')).not.toBeInTheDocument();
    });

    it('calls onChangeLinkPrivilege when privilege option is selected for link', async () => {
      const onChangeLinkPrivilege = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onChangeLinkPrivilege={onChangeLinkPrivilege} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-privilege-option-link1-write')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('link-privilege-option-link1-write'));

      await waitFor(() => {
        expect(onChangeLinkPrivilege).toHaveBeenCalledWith('link1', 'write');
      });
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('shows Change Name option in link dropdown', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
    });

    it('shows Revoke Link option in link dropdown', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
    });
  });

  describe('inline edit', () => {
    it('enters inline edit mode when Change Name is selected', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });
    });

    it('saves name on Enter key', async () => {
      const onSaveLinkName = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onSaveLinkName={onSaveLinkName} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });

      const input = screen.getByTestId('link-name-input-link1');
      await user.clear(input);
      await user.type(input, 'New Name{Enter}');

      expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'New Name');
    });

    it('cancels edit on Escape key', async () => {
      const onSaveLinkName = vi.fn();
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onSaveLinkName={onSaveLinkName} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });

      await user.type(screen.getByTestId('link-name-input-link1'), '{Escape}');

      expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
      expect(onSaveLinkName).not.toHaveBeenCalled();
    });
  });

  describe('footer', () => {
    function budgetRow(
      overrides: Partial<ConversationBudgetsResponse['members'][number]>
    ): ConversationBudgetsResponse['members'][number] {
      return {
        memberId: 'm3',
        userId: 'u3',
        username: 'charlie',
        privilege: 'write',
        capNanoUsd: '50000000000',
        spentNanoUsd: '15000000000',
        effectiveRemainingNanoUsd: '35000000000',
        ...overrides,
      };
    }

    function serveBudgets(overrides: Partial<ConversationBudgetsResponse>): void {
      const data: ConversationBudgetsResponse = {
        conversationCapNanoUsd: '20000000000',
        conversationSpentNanoUsd: '10000000000',
        ownerBalanceNanoUsd: '200000000000',
        members: [],
        ...overrides,
      };
      mockUseConversationBudgets.mockReturnValue({ data, isLoading: false });
    }

    function foot(): HTMLElement {
      return screen.getByTestId(TEST_IDS.memberBudgetFooter);
    }

    it('renders the budget foot', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      expect(foot()).toBeInTheDocument();
    });

    it('offers the owner Change budgets', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName(
        'Change budgets'
      );
    });

    it('offers a member See budgets', () => {
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName('See budgets');
    });

    it('calls onBudgetSettingsClick when footer trigger is clicked', async () => {
      const user = userEvent.setup();
      const onBudgetSettingsClick = vi.fn();
      renderPane(<MemberSidebar {...defaultProps} onBudgetSettingsClick={onBudgetSettingsClick} />);

      await user.click(screen.getByTestId(TEST_IDS.memberBudgetTrigger));

      expect(onBudgetSettingsClick).toHaveBeenCalled();
    });

    it('shows the conversation spend of the overall budget to the owner', () => {
      serveBudgets({});

      renderPane(<MemberSidebar {...defaultProps} />);

      expect(foot()).toHaveTextContent('$10.00 of $20.00 spent');
    });

    it('shows $0.00 spent when the owner has spent nothing', () => {
      serveBudgets({ conversationSpentNanoUsd: '0', conversationCapNanoUsd: '100000000000' });

      renderPane(<MemberSidebar {...defaultProps} />);

      expect(foot()).toHaveTextContent('$0.00 of $100.00 spent');
    });

    it('reads the overall budget rather than the owner balance', () => {
      serveBudgets({
        conversationSpentNanoUsd: '0',
        conversationCapNanoUsd: '50000000000',
        ownerBalanceNanoUsd: '999000000000',
      });

      renderPane(<MemberSidebar {...defaultProps} />);

      expect(foot()).toHaveTextContent('$0.00 of $50.00 spent');
    });

    it('shows a member their own spend of their own budget', () => {
      serveBudgets({ ownerBalanceNanoUsd: null, members: [budgetRow({})] });

      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      expect(foot()).toHaveTextContent('$15.00 of $50.00 spent');
    });

    it('matches the member row by memberId for link guests', () => {
      serveBudgets({
        ownerBalanceNanoUsd: null,
        members: [
          budgetRow({
            memberId: 'link-abc',
            userId: null,
            username: null,
            capNanoUsd: '40000000000',
            spentNanoUsd: '5000000000',
          }),
        ],
      });

      // A link guest is identified by their member id (the response carries no linkId).
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="link-abc" currentUserPrivilege="write" />
      );

      expect(foot()).toHaveTextContent('$5.00 of $40.00 spent');
    });

    it('shows a $0.00 budget as it is served', () => {
      serveBudgets({
        ownerBalanceNanoUsd: null,
        members: [
          budgetRow({
            memberId: 'link-abc',
            userId: null,
            username: null,
            capNanoUsd: '0',
            spentNanoUsd: '0',
            effectiveRemainingNanoUsd: '0',
          }),
        ],
      });

      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="link-abc" currentUserPrivilege="write" />
      );

      expect(foot()).toHaveTextContent('$0.00 of $0.00 spent');
    });

    it('shows no figures for a non-owner with no matching budget row', () => {
      serveBudgets({
        ownerBalanceNanoUsd: null,
        members: [budgetRow({ memberId: 'other-member', userId: 'other-user' })],
      });

      renderPane(
        <MemberSidebar
          {...defaultProps}
          currentUserId="link-no-match"
          currentUserPrivilege="write"
        />
      );

      expect(foot()).not.toHaveTextContent('$');
    });

    it('shows owner warning in leave confirmation modal from dropdown', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-warning')).toHaveTextContent(
          'delete all messages'
        );
      });
    });

    it('shows non-owner warning in leave confirmation modal from dropdown', async () => {
      const user = userEvent.setup();
      renderPane(
        <MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />
      );

      await user.click(screen.getByTestId('member-actions-m3'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-warning')).toHaveTextContent('lose access');
      });
    });
  });

  describe('row money', () => {
    it('passes the owner their own balance from the budgets read', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '0',
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: centsToNanoUsd(1248),
          members: [],
        } satisfies ConversationBudgetsResponse,
        isLoading: false,
      });

      renderPane(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m1'))).toHaveTextContent(
        '$12.48balance'
      );
    });

    it('asks no budgets read for a link guest', () => {
      setLinkGuestAuth('link-guest-key');

      renderPane(<MemberSidebar {...defaultProps} />);

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
      expect(mockUseConversationBudgets).not.toHaveBeenCalledWith(defaultProps.conversationId);
    });

    it('asks no budgets read for a conversation it is not given', () => {
      renderPane(<MemberSidebar />);

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });
  });

  describe('link-guest members (null userId/username)', () => {
    // A link guest reaching the members list carries null userId/username; the
    // rows must render a fallback instead of throwing in displayUsername(null).
    function membersWithGuest(): {
      id: string;
      userId: string | null;
      username: string | null;
      privilege: string;
    }[] {
      return [
        { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
        { id: 'guest', userId: null, username: null, privilege: 'read' },
      ];
    }

    it('renders a null-username guest row without throwing and shows the Guest fallback', () => {
      expect(() =>
        renderPane(<MemberSidebar {...defaultProps} members={membersWithGuest()} />)
      ).not.toThrow();
      const guestRow = screen.getByTestId('member-item-guest');
      expect(guestRow).toHaveTextContent('Guest');
      // Real member keeps their normal display name.
      expect(screen.getByTestId('member-item-m1')).toHaveTextContent('Alice');
    });

    it('treats a null-userId guest as offline (no online indicator)', () => {
      renderPane(
        <MemberSidebar
          {...defaultProps}
          members={membersWithGuest()}
          onlineMemberIds={new Set(['u1'])}
        />
      );
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'guest'))
      ).not.toBeInTheDocument();
      // The real online member still shows the indicator.
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))).toBeInTheDocument();
    });

    it('does not throw when searching with a null-username guest present', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} members={membersWithGuest()} />);
      await user.type(screen.getByTestId('member-search-input'), 'ali');
      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-guest')).not.toBeInTheDocument();
    });
  });

  describe('body', () => {
    it('scrolls the lists between the head and the pinned foot', () => {
      renderPane(<MemberSidebar {...defaultProps} />);

      const content = screen.getByTestId(TEST_IDS.memberSidebarContent);
      const foot = screen.getByTestId(TEST_IDS.memberBudgetFooter);
      expect(content).toHaveClass('overflow-y-auto');
      expect(content.compareDocumentPosition(foot)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(content).not.toContainElement(foot);
    });
  });

  describe('loading state', () => {
    it('renders Decrypting... placeholder with lock icon when no data props are provided', () => {
      renderPane(<MemberSidebar />);

      expect(screen.getByTestId('decrypting-indicator')).toBeInTheDocument();
      expect(screen.getByTestId('decrypting-lock-icon')).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    });

    it('renders the pane even without data', () => {
      renderPane(<MemberSidebar />);

      expect(within(slot()).getByTestId(TEST_IDS.memberSidebar)).toBeInTheDocument();
    });

    it('names the pane Members without a count while loading', () => {
      renderPane(<MemberSidebar />);

      expect(within(slot()).getByRole('heading', { name: 'Members' })).toBeInTheDocument();
      expect(screen.queryByText(/^·/)).not.toBeInTheDocument();
    });

    it('does not render member content when loading', () => {
      renderPane(<MemberSidebar />);

      expect(screen.queryByTestId('member-sidebar-content')).not.toBeInTheDocument();
    });

    it('does not render footer when loading', () => {
      renderPane(<MemberSidebar />);

      expect(screen.queryByTestId('member-budget-footer')).not.toBeInTheDocument();
    });

    it('renders content when currentUserId is empty string (guest)', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserId="" currentUserPrivilege="read" />);

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
      expect(screen.queryByTestId('decrypting-indicator')).not.toBeInTheDocument();
    });

    it('does not show (you) badge when currentUserId is empty string', () => {
      renderPane(<MemberSidebar {...defaultProps} currentUserId="" currentUserPrivilege="read" />);

      expect(screen.queryByTestId('member-you-badge')).not.toBeInTheDocument();
    });
  });

  describe('conversation switching', () => {
    it('clears the search query when conversationId changes', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPane(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      expect(screen.getByTestId('member-search-input')).toHaveValue('ali');

      rerender(<MemberSidebar {...defaultProps} conversationId="conv-B" />);

      expect(screen.getByTestId('member-search-input')).toHaveValue('');
    });

    it('keeps the search query when conversationId is unchanged across rerenders', async () => {
      const user = userEvent.setup();
      const { rerender } = renderPane(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      rerender(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      expect(screen.getByTestId('member-search-input')).toHaveValue('ali');
    });
  });

  describe('omitted callbacks', () => {
    it('renders rows without crashing when mutation callbacks are omitted', async () => {
      const user = userEvent.setup();
      renderPane(
        <MemberSidebar
          {...defaultProps}
          onChangePrivilege={undefined}
          onSaveLinkName={undefined}
          onChangeLinkPrivilege={undefined}
          onRemoveMember={undefined}
          onRevokeLinkClick={undefined}
        />
      );

      // Member remove confirm with onRemoveMember omitted closes the modal
      // without throwing (optional-chaining no-op path).
      await user.click(screen.getByTestId('member-actions-m2'));
      await user.click(await screen.findByTestId('member-remove-action-m2'));
      await user.click(await screen.findByTestId('remove-member-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
      });
    });

    it('closes the revoke modal without throwing when onRevokeLinkClick is omitted', async () => {
      const user = userEvent.setup();
      renderPane(<MemberSidebar {...defaultProps} onRevokeLinkClick={undefined} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await user.click(await screen.findByTestId('link-revoke-action-link1'));
      await user.click(await screen.findByTestId('revoke-link-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId('revoke-link-modal')).not.toBeInTheDocument();
      });
    });

    it('does not render the budget footer add/invite when callbacks omitted (no crash)', () => {
      renderPane(
        <MemberSidebar
          {...defaultProps}
          onAddMember={undefined}
          onInviteLink={undefined}
          onBudgetSettingsClick={undefined}
        />
      );

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
    });

    it('falls back to empty links and presence when those props are omitted', () => {
      renderPane(<MemberSidebar {...defaultProps} links={undefined} onlineMemberIds={undefined} />);

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
      // The alice/bob member rows still render off the members prop.
      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
    });
  });
});
