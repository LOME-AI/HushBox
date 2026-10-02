import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  TEST_DAY_START,
  TEST_LOCAL_DAY_START,
  freezeClock,
  isoAt,
} from '@hushbox/shared/test-time';
import { usePaletteStore } from '@/stores/ui/palette';
import { useUIStore } from '@/stores/ui/ui';
import { useRightPane } from '@/stores/ui/right-pane';
import { SidebarContent } from './sidebar-content';
import type { ReactElement, ReactNode } from 'react';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/chat/some-id' }),
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="link">
      {children}
    </a>
  ),
  useParams: () => ({ conversationId: undefined }),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

vi.mock('@/lib/auth/auth', () => ({
  useAuthStore: <T,>(selector: (s: { user: { id: string } | null }) => T): T =>
    selector({ user: { id: 'user-1' } }),
}));

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useAcceptMembership: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  }),
  useDeclineInvitation: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  }),
  useMuteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  usePinConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

/** Noon on the reference day in the viewer's own zone, so every local-day boundary is a whole day off. */
const LOCAL_NOON = TEST_LOCAL_DAY_START + 12 * HOUR_MS;

function conversationAt(
  id: string,
  title: string,
  updatedAtMs: number,
  pinned = false
): {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  privilege: 'owner';
  muted: boolean;
  pinned: boolean;
  memberCount: number;
} {
  return {
    id,
    title,
    currentEpoch: 1,
    updatedAt: isoAt(updatedAtMs),
    privilege: 'owner',
    muted: false,
    pinned,
    memberCount: 1,
  };
}

function headingNames(): string[] {
  return screen.getAllByRole('heading').map((heading) => heading.textContent);
}

function installIntersectionObserver(): void {
  class InertIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
    takeRecords = vi.fn((): IntersectionObserverEntry[] => []);
    root: Element | null = null;
    rootMargin = '';
    thresholds: readonly number[] = [];
  }
  vi.stubGlobal('IntersectionObserver', InertIntersectionObserver);
}

describe('SidebarContent', () => {
  const mockConversations = [
    {
      id: 'conv-1',
      title: 'Test Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner' as const,
      muted: false,
      pinned: false,
      memberCount: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useRightPane.setState({ active: null });
    useUIStore.setState({ sidebarOpen: true });
  });

  it('renders NewChatButton', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
  });

  it('renders the Search row when sidebar is open', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(
      screen.getByRole('button', { name: 'Search conversations and actions' })
    ).toHaveTextContent('Search');
  });

  it('leaves out the in-place conversation filter', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens the command palette from the Search row', async () => {
    usePaletteStore.setState({ open: false });
    const user = userEvent.setup();
    render(<SidebarContent conversations={mockConversations} />);

    await user.click(screen.getByRole('button', { name: 'Search conversations and actions' }));

    expect(usePaletteStore.getState().open).toBe(true);
  });

  it('gives the Search row its shortcut hint for a signed-in user', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const search = screen.getByRole('button', { name: 'Search conversations and actions' });
    expect(search.querySelector('kbd')).not.toBeNull();
  });

  it('gives the trial body a Search row with no shortcut hint', () => {
    render(<SidebarContent conversations={[]} isAuthenticated={false} />);
    const search = screen.getByRole('button', { name: 'Search conversations and actions' });
    expect(search.querySelector('kbd')).toBeNull();
  });

  it('keeps the trial body line to sign up to save conversations', () => {
    render(<SidebarContent conversations={[]} isAuthenticated={false} />);
    expect(screen.getByRole('link', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.getByText(/to save conversations/)).toBeInTheDocument();
  });

  it('renders ChatList with conversations', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByText('Test Conversation')).toBeInTheDocument();
  });

  it('renders in order: New chat, Search, then the conversation list', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const newChat = screen.getByTestId(TEST_IDS.newChatRow);
    const search = screen.getByTestId(TEST_IDS.sidebarSearchRow);
    const list = screen.getByTestId(TEST_IDS.chatListScrollContainer);

    expect(newChat.compareDocumentPosition(search)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING as number
    );
    expect(search.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
  });

  it('draws the body rule between the Search row and the conversation list', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const nav = screen.getByTestId(TEST_IDS.sidebarNav);
    const rules = nav.querySelectorAll('[data-slot="separator"]');
    const search = screen.getByTestId(TEST_IDS.sidebarSearchRow);
    const list = screen.getByTestId(TEST_IDS.chatListScrollContainer);

    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(search.compareDocumentPosition(rule)).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
    expect(rule.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
  });

  it('keeps New chat and Search above the decrypting indicator while conversations load', () => {
    render(<SidebarContent conversations={[]} isLoading />);
    const search = screen.getByTestId(TEST_IDS.sidebarSearchRow);
    const indicator = screen.getByTestId(TEST_IDS.decryptingIndicator);

    expect(screen.getByTestId(TEST_IDS.newChatRow)).toBeInTheDocument();
    expect(search.compareDocumentPosition(indicator)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING as number
    );
    expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
  });

  it('keeps the body rule above the decrypting indicator while conversations load', () => {
    render(<SidebarContent conversations={[]} isLoading />);
    const rules = screen
      .getByTestId(TEST_IDS.sidebarNav)
      .querySelectorAll('[data-slot="separator"]');
    const indicator = screen.getByTestId(TEST_IDS.decryptingIndicator);

    expect(rules).toHaveLength(1);
    expect(rules[0]!.compareDocumentPosition(indicator)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING as number
    );
  });

  it('has aria-label on navigation', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const nav = screen.getByRole('navigation');
    expect(nav).toHaveAttribute('aria-label', 'Chat navigation');
  });

  it('shows scrollbar on chat list container when sidebar is open', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const container = screen.getByTestId(TEST_IDS.chatListScrollContainer);
    expect(container).not.toHaveClass('scrollbar-hide');
  });

  describe('beside a docked right pane', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: true });
      useRightPane.setState({ active: 'members' });
    });

    it('draws its rail form while the saved choice is open', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByText('Search')).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.chatLink)).not.toBeInTheDocument();
    });
  });

  describe('on the rail', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('hides the row labels', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByText('New chat')).not.toBeInTheDocument();
      expect(screen.queryByText('Search')).not.toBeInTheDocument();
    });

    it('keeps New chat', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.getByTestId(TEST_IDS.newChatRow)).toBeInTheDocument();
    });

    it('keeps the Search row', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(
        screen.getByRole('button', { name: 'Search conversations and actions' })
      ).toBeInTheDocument();
    });

    it('draws no conversation rows', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByTestId(TEST_IDS.chatListScrollContainer)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.chatLink)).not.toBeInTheDocument();
    });

    it('draws no rule under Search', () => {
      render(<SidebarContent conversations={mockConversations} />);
      const nav = screen.getByTestId(TEST_IDS.sidebarNav);
      expect(nav.querySelectorAll('[data-slot="separator"]')).toHaveLength(0);
    });

    it('draws no decrypting lock while conversations load', () => {
      render(<SidebarContent conversations={[]} isLoading />);
      expect(screen.queryByTestId(TEST_IDS.decryptingIndicator)).not.toBeInTheDocument();
    });
  });

  describe('invite navigation', () => {
    const acceptedConvs = [
      {
        id: 'conv-1',
        title: 'Design Chat',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
      {
        id: 'conv-2',
        title: 'Weekend Plans',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'write' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
    ];

    const unacceptedConvs = [
      {
        id: 'conv-3',
        title: 'Team Standup',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: false,
        invitedByUsername: 'sarah',
        privilege: 'write' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
    ];

    const mixedConvs = [...acceptedConvs, ...unacceptedConvs];

    it('shows no Recent Chats / Invites switch while no invite waits', () => {
      render(<SidebarContent conversations={acceptedConvs} />);
      expect(screen.queryByText('Recent Chats')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });

    it('renders clickable buttons when unaccepted conversations exist', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByRole('button', { name: /recent chats/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /invites/i })).toBeInTheDocument();
    });

    it('shows invite count badge on Invites button', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      const invitesButton = screen.getByRole('button', { name: /invites/i });
      expect(invitesButton).toHaveTextContent('1');
    });

    it('shows accepted conversations by default', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.getByText('Weekend Plans')).toBeInTheDocument();
    });

    it('slides to inbox content when Invites is clicked', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      render(<SidebarContent conversations={mixedConvs} />);

      await userEvent.click(screen.getByRole('button', { name: /invites/i }));

      expect(screen.getByTestId(TEST_IDS.inboxContent)).toBeInTheDocument();
      expect(screen.getByText('Team Standup')).toBeInTheDocument();
    });

    it('keeps chat list in DOM during slide (both panels render)', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.inboxContent)).toBeInTheDocument();
    });

    it('shows no switch when no conversation has the accepted field', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByText('Recent Chats')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });

    it('draws the switch below the body rule', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      const rule = screen.getByTestId(TEST_IDS.sidebarNav).querySelector('[data-slot="separator"]');
      const recent = screen.getByRole('button', { name: /recent chats/i });

      expect(rule).not.toBeNull();
      expect(rule!.compareDocumentPosition(recent)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING as number
      );
    });

    it('hides the switch on the rail', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });
  });

  describe('pinned conversations', () => {
    it('renders pinned conversations above unpinned', () => {
      const conversations = [
        {
          id: 'conv-unpinned-1',
          title: 'Unpinned First',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + 3 * HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
          memberCount: 1,
        },
        {
          id: 'conv-pinned',
          title: 'Pinned Chat',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
          memberCount: 1,
        },
        {
          id: 'conv-unpinned-2',
          title: 'Unpinned Second',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + 2 * HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
          memberCount: 1,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Pinned Chat');
      expect(items[1]).toHaveTextContent('Unpinned First');
      expect(items[2]).toHaveTextContent('Unpinned Second');
    });

    it('renders separator between pinned and unpinned conversations', () => {
      const conversations = [
        {
          id: 'conv-pinned',
          title: 'Pinned Chat',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
          memberCount: 1,
        },
        {
          id: 'conv-unpinned',
          title: 'Unpinned Chat',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + 2 * HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
          memberCount: 1,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      expect(screen.getByTestId(TEST_IDS.pinnedSeparator)).toBeInTheDocument();
    });

    it('does not render separator when no conversations are pinned', () => {
      render(<SidebarContent conversations={mockConversations} />);

      expect(screen.queryByTestId(TEST_IDS.pinnedSeparator)).not.toBeInTheDocument();
    });

    it('does not render separator when all conversations are pinned', () => {
      const conversations = [
        {
          id: 'conv-pinned-1',
          title: 'Pinned One',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
          memberCount: 1,
        },
        {
          id: 'conv-pinned-2',
          title: 'Pinned Two',
          currentEpoch: 1,
          updatedAt: isoAt(TEST_DAY_START + 2 * HOUR_MS),
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
          memberCount: 1,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      expect(screen.queryByTestId(TEST_IDS.pinnedSeparator)).not.toBeInTheDocument();
    });
  });

  describe('tab behavior', () => {
    const accepted = [
      {
        id: 'a-1',
        title: 'Design Chat',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
      {
        id: 'a-2',
        title: 'Weekend Plans',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
    ];
    const unaccepted = [
      {
        id: 'u-1',
        title: 'Team Standup',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: false,
        invitedByUsername: 'sarah',
        privilege: 'write' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
      {
        id: 'u-2',
        title: 'Anon Invite',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: false,
        invitedByUsername: null,
        privilege: 'write' as const,
        muted: false,
        pinned: false,
        memberCount: 1,
      },
    ];
    const mixed = [...accepted, ...unaccepted];

    it('switches back to Recent Chats from the inbox tab', async () => {
      const user = userEvent.setup();
      render(<SidebarContent conversations={mixed} />);

      await user.click(screen.getByRole('button', { name: /invites/i }));
      await user.click(screen.getByRole('button', { name: /recent chats/i }));

      expect(screen.getByText('Design Chat')).toBeInTheDocument();
    });

    it('auto-switches to Recent Chats when the last invite is handled', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SidebarContent conversations={mixed} />);

      await user.click(screen.getByRole('button', { name: /invites/i }));
      expect(screen.getByText('Team Standup')).toBeInTheDocument();

      // The remaining invites drop to zero while viewing the inbox tab.
      rerender(<SidebarContent conversations={accepted} />);

      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });
  });

  describe('date groups', () => {
    const today = conversationAt('c-today', 'Merging duplicate contacts', LOCAL_NOON - HOUR_MS);
    const earlierToday = conversationAt(
      'c-today-2',
      'Lease renewal letter',
      LOCAL_NOON - 2 * HOUR_MS
    );
    const thisWeek = conversationAt(
      'c-week',
      'TCP vs UDP for game netcode',
      LOCAL_NOON - 3 * DAY_MS
    );
    const thisMonth = conversationAt('c-month', 'Rust lifetimes', LOCAL_NOON - 20 * DAY_MS);
    const older = conversationAt('c-older', 'Companion planting', LOCAL_NOON - 60 * DAY_MS);

    beforeEach(() => {
      freezeClock(LOCAL_NOON, { toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('groups conversations under Today, Previous 7 days, Previous 30 days and Older, in that order', () => {
      render(<SidebarContent conversations={[today, earlierToday, thisWeek, thisMonth, older]} />);

      expect(headingNames()).toEqual(['Today', 'Previous 7 days', 'Previous 30 days', 'Older']);
    });

    it('puts each conversation in the group of its last update', () => {
      render(<SidebarContent conversations={[today, thisWeek, thisMonth, older]} />);

      const inGroup = (label: string): string[] =>
        within(screen.getByTestId(TEST_ID_BUILDERS.conversationGroup(label)))
          .getAllByRole('listitem')
          .map((item) => item.textContent);
      expect(inGroup('Today')).toEqual(['Merging duplicate contacts']);
      expect(inGroup('Previous 7 days')).toEqual(['TCP vs UDP for game netcode']);
      expect(inGroup('Previous 30 days')).toEqual(['Rust lifetimes']);
      expect(inGroup('Older')).toEqual(['Companion planting']);
    });

    it('keeps the list order inside a group', () => {
      render(<SidebarContent conversations={[earlierToday, today]} />);

      const items = within(screen.getByTestId(TEST_ID_BUILDERS.conversationGroup('Today')))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(items).toEqual(['Lease renewal letter', 'Merging duplicate contacts']);
    });

    it('omits a group no conversation falls in', () => {
      render(<SidebarContent conversations={[today, older]} />);

      expect(headingNames()).toEqual(['Today', 'Older']);
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.conversationGroup('Previous 7 days'))
      ).not.toBeInTheDocument();
    });

    it('leaves pinned conversations out of the date groups', () => {
      const pinnedToday = conversationAt('c-pin', 'Pinned plan', LOCAL_NOON - HOUR_MS, true);
      render(<SidebarContent conversations={[pinnedToday, older]} />);

      expect(headingNames()).toEqual(['Older']);
      expect(screen.getByRole('list', { name: 'Pinned conversations' })).toHaveTextContent(
        'Pinned plan'
      );
    });

    it('lists the pinned conversations above the first date group, with no title of their own', () => {
      const pinned = conversationAt('c-pin', 'Pinned plan', LOCAL_NOON - 90 * DAY_MS, true);
      render(<SidebarContent conversations={[pinned, today]} />);

      const pinnedList = screen.getByRole('list', { name: 'Pinned conversations' });
      const firstGroup = screen.getByTestId(TEST_ID_BUILDERS.conversationGroup('Today'));
      expect(pinnedList.compareDocumentPosition(firstGroup)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING as number
      );
      expect(headingNames()).toEqual(['Today']);
    });

    it('divides the pinned conversations from the date groups with the pinned separator', () => {
      const pinned = conversationAt('c-pin', 'Pinned plan', LOCAL_NOON - HOUR_MS, true);
      render(<SidebarContent conversations={[pinned, today]} />);

      const separator = screen.getByTestId(TEST_IDS.pinnedSeparator);
      const firstGroup = screen.getByTestId(TEST_ID_BUILDERS.conversationGroup('Today'));
      expect(
        screen
          .getByRole('list', { name: 'Pinned conversations' })
          .compareDocumentPosition(separator)
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
      expect(separator.compareDocumentPosition(firstGroup)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING as number
      );
    });
  });

  describe('infinite scroll', () => {
    const recent = conversationAt('c-recent', 'Recent chat', LOCAL_NOON - HOUR_MS);
    const old = conversationAt('c-old', 'Old chat', LOCAL_NOON - 60 * DAY_MS);

    beforeEach(() => {
      freezeClock(LOCAL_NOON, { toFake: ['Date'] });
      installIntersectionObserver();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function sentinels(): HTMLElement[] {
      return screen
        .getAllByRole('listitem', { hidden: true })
        .filter((item) => item.getAttribute('aria-hidden') === 'true');
    }

    it('keeps one load-more sentinel, at the end of the last date group', () => {
      render(<SidebarContent conversations={[recent, old]} hasMore onLoadMore={vi.fn()} />);

      expect(sentinels()).toHaveLength(1);
      expect(
        within(screen.getByTestId(TEST_ID_BUILDERS.conversationGroup('Older')))
          .getAllByRole('listitem', { hidden: true })
          .at(-1)
      ).toBe(sentinels()[0]);
    });

    it('keeps the sentinel at the end of the pinned list when every loaded conversation is pinned', () => {
      const pinned = conversationAt('c-pin', 'Pinned plan', LOCAL_NOON - HOUR_MS, true);
      render(<SidebarContent conversations={[pinned]} hasMore onLoadMore={vi.fn()} />);

      expect(sentinels()).toHaveLength(1);
      expect(
        within(screen.getByRole('list', { name: 'Pinned conversations' }))
          .getAllByRole('listitem', { hidden: true })
          .at(-1)
      ).toBe(sentinels()[0]);
    });

    it('draws no sentinel once every conversation is loaded', () => {
      render(<SidebarContent conversations={[recent, old]} hasMore={false} onLoadMore={vi.fn()} />);

      expect(sentinels()).toHaveLength(0);
    });
  });
});
