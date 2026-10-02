import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useUIStore } from '@/stores/ui/ui';
import { useRightPane } from '@/stores/ui/right-pane';
import {
  routerLocationMock,
  routerPathnameMock,
  SidebarLinkMock,
} from '@/test-utils/sidebar-router-mock';

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversations', id] as const,
    messages: (conversationId: string) =>
      ['chat', 'conversations', conversationId, 'messages'] as const,
  },
}));

import { useDecryptedConversations } from '@/hooks/chat/chat';

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

function mockConversationsHook(
  overrides?: Partial<ReturnType<typeof useDecryptedConversations>>
): void {
  mockUseDecryptedConversations.mockReturnValue({
    data: [],
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  });
}

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

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(() => ({
    data: {
      user: { id: 'user-1', email: 'test@example.com', username: 'test_user' },
      session: { id: 'session-1' },
    },
    isPending: false,
  })),
  useAuthStore: <T,>(selector: (s: { user: { id: string } | null }) => T): T =>
    selector({ user: { id: 'user-1' } }),
  signOutAndClearCache: vi.fn(),
}));

import { useSession } from '@/lib/auth/auth';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import { Sidebar } from './sidebar';
import type { ReactNode } from 'react';

const mockUseSession = vi.mocked(useSession);
const mockUseEnablePrompt = vi.mocked(useEnablePrompt);
const enableOffer = vi.fn();
const dismissOffer = vi.fn();

const useParamsMock = vi.fn<() => { id: string | undefined }>(() => ({ id: undefined }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: routerLocationMock,
  Link: SidebarLinkMock,
  useParams: () => useParamsMock(),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({
    displayBalance: '10000000000',
    isStable: true,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

// The acquisition-channel prompt shares the slot; unmocked, its account query reaches for
// the API on every render. No channel prompt is due, so the notification offer is the one shown.
vi.mock('@/hooks/growth/use-acquisition-source', () => ({
  useAcquisitionSource: () => ({ data: undefined }),
  useSelfReport: () => ({ submit: vi.fn(), isSubmitting: false }),
}));

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({
  useEnablePrompt: vi.fn(() => ({
    isVisible: true,
    isEnabling: false,
    enable: vi.fn(),
    dismiss: vi.fn(),
  })),
}));

const originalMatchMedia = globalThis.matchMedia;

/**
 * Narrows the window below 768px. The sidebar and its frame both read the viewport band
 * through the media query, so this is the one switch that moves them together.
 */
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

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

const testConv = {
  id: 'conv-1',
  userId: 'user-1',
  title: 'Test Chat',
  currentEpoch: 1,
  titleEpochNumber: 1,
  nextSequence: 1,
  createdAt: isoAt(TEST_DAY_START),
  updatedAt: isoAt(TEST_DAY_START),
  accepted: true,
  invitedByUsername: null,
  privilege: 'owner' as const,
  muted: false,
  pinned: false,
  lastReadSeq: 0,
  memberCount: 1,
};

describe('Sidebar', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
    useRightPane.setState({ active: null });
    useParamsMock.mockReturnValue({ id: undefined });
    routerPathnameMock.mockReturnValue('/');
    enableOffer.mockClear();
    dismissOffer.mockClear();
    mockUseEnablePrompt.mockReturnValue({
      isVisible: true,
      isEnabling: false,
      enable: enableOffer,
      dismiss: dismissOffer,
    });
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
        },
        session: { id: 'session-1' },
      },
      isPending: false,
    });
    mockConversationsHook({ data: [testConv] });
  });

  describe('desktop view', () => {
    it('renders aside element', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders sidebar header', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarHeader)).toBeInTheDocument();
    });

    it('renders SidebarFooter', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarFooter)).toBeInTheDocument();
    });

    it('has w-72 class when sidebar is open', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-72');
    });

    it('has the 3.5rem w-14 class when sidebar is collapsed (rail mode)', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-14');
    });

    it('uses sidebar background color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('bg-sidebar');
    });

    it('uses sidebar border color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside.className).toContain('border-r');
    });

    it('uses sidebar foreground color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('text-sidebar-foreground');
    });

    it('has transition class for smooth animation', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('transition-[width]');
    });

    it('has right border', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('border-r');
    });
  });

  describe('content area', () => {
    it('renders SidebarContent navigation', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarNav)).toBeInTheDocument();
    });

    it('renders NewChatButton', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
    });

    it('renders the Search row', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(
        screen.getByRole('button', { name: 'Search conversations and actions' })
      ).toBeInTheDocument();
    });

    it('draws no rule under the head, leaving the rule under Search the only one', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const nav = screen.getByTestId(TEST_IDS.sidebarNav);

      expect(screen.getByTestId(TEST_IDS.sidebarHeader)).not.toHaveClass('border-b');
      expect(nav.querySelectorAll('[data-slot="separator"]')).toHaveLength(1);
    });

    it('draws no rule under the head on the rail either', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByTestId(TEST_IDS.sidebarHeader)).not.toHaveClass('border-b');
    });

    it('draws no rule under the head in the phone drawer', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });
      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByTestId(TEST_IDS.sidebarHeader)).not.toHaveClass('border-b');
    });
  });

  describe('the rail', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('holds New chat, Search, the notification stand-in and the account button, in that order', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const rail = screen.getByTestId(TEST_IDS.sidebar);
      const controls = [
        within(rail).getByTestId(TEST_IDS.newChatRow),
        within(rail).getByRole('button', { name: 'Search conversations and actions' }),
        within(rail).getByRole('button', { name: 'Turn on notifications' }),
        within(rail).getByTestId(TEST_IDS.accountButton),
      ];

      for (const [index, control] of controls.slice(1).entries()) {
        expect(controls[index]!.compareDocumentPosition(control)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING as number
        );
      }
    });

    it('draws no conversation, as an icon or otherwise', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const rail = screen.getByTestId(TEST_IDS.sidebar);

      expect(within(rail).queryByTestId(TEST_IDS.chatLink)).not.toBeInTheDocument();
      expect(within(rail).queryByTestId(TEST_IDS.messageIcon)).not.toBeInTheDocument();
      expect(within(rail).queryByRole('link', { name: testConv.title })).not.toBeInTheDocument();
    });
  });

  describe('release stage badge', () => {
    const BADGE_NAME = 'Beta: read what that means';

    it('links the head to the beta section of the Terms', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const head = screen.getByTestId(TEST_IDS.sidebarHeader);

      expect(within(head).getByRole('link', { name: BADGE_NAME })).toHaveAttribute(
        'href',
        '/terms#beta'
      );
    });

    it('sits beside the logo link rather than inside it', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const badge = screen.getByRole('link', { name: BADGE_NAME });

      expect(badge.parentElement?.closest('a')).toBeNull();
    });

    it('follows the logo link', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const logo = screen.getByTestId(TEST_IDS.logo).closest('a');
      const badge = screen.getByRole('link', { name: BADGE_NAME });

      expect(logo?.compareDocumentPosition(badge)).toBe(Node.DOCUMENT_POSITION_FOLLOWING as number);
    });

    it('stays off the rail, folding away with the logo', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.queryByRole('link', { name: BADGE_NAME })).not.toBeInTheDocument();
    });

    it('rides the head of the phone drawer', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });
      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('link', { name: BADGE_NAME })).toBeInTheDocument();
    });
  });

  describe('beside a docked right pane', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('folds an open sidebar to its rail while a pane is docked', () => {
      useRightPane.setState({ active: 'members' });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-14');
    });

    it('opens again once the pane closes', () => {
      useRightPane.setState({ active: 'members' });
      render(<Sidebar />, { wrapper: createWrapper() });

      act(() => {
        useRightPane.getState().close();
      });

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-72');
    });

    it('stays on the rail the user chose once the pane closes', () => {
      useUIStore.setState({ sidebarOpen: false });
      useRightPane.setState({ active: 'members' });
      render(<Sidebar />, { wrapper: createWrapper() });

      act(() => {
        useRightPane.getState().close();
      });

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-14');
    });

    it('writes nothing to the saved choice as a pane opens and closes', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const setItem = vi.spyOn(Storage.prototype, 'setItem');

      act(() => {
        useRightPane.getState().open('members');
      });
      act(() => {
        useRightPane.getState().close();
      });

      expect(setItem).not.toHaveBeenCalledWith('hushbox-ui-storage', expect.anything());
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('keeps the phone drawer whole while a pane is open', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });
      useRightPane.setState({ active: 'members' });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(
        within(screen.getByTestId(TEST_IDS.sidebar)).queryByRole('button', {
          name: 'Expand sidebar',
        })
      ).not.toBeInTheDocument();
    });

    it('closes the pane when the rail is expanded', async () => {
      const user = userEvent.setup();
      useRightPane.setState({ active: 'members' });
      render(<Sidebar />, { wrapper: createWrapper() });

      await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

      expect(useRightPane.getState().active).toBeNull();
    });

    it('opens the sidebar when the rail is expanded over a pane', async () => {
      const user = userEvent.setup();
      useUIStore.setState({ sidebarOpen: false });
      useRightPane.setState({ active: 'members' });
      render(<Sidebar />, { wrapper: createWrapper() });

      await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-72');
    });

    it('keeps a saved open sidebar open when its folded rail is expanded', async () => {
      const user = userEvent.setup();
      useRightPane.setState({ active: 'members' });
      render(<Sidebar />, { wrapper: createWrapper() });

      await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));

      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('data fetching', () => {
    it('calls useDecryptedConversations hook', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(mockUseDecryptedConversations).toHaveBeenCalled();
    });

    it('shows decrypting state with lock icon when fetching', () => {
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.decryptingIndicator)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.decryptingLockIcon)).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    });

    it('keeps New chat and Search in place while conversations decrypt', () => {
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Search conversations and actions' })
      ).toBeInTheDocument();
    });

    it('draws no decrypting lock on the rail while conversations load', () => {
      useUIStore.setState({ sidebarOpen: false });
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByTestId(TEST_IDS.decryptingLockIcon)).not.toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
    });

    it('marks a dated conversation that has other members with the users icon', () => {
      mockConversationsHook({ data: [{ ...testConv, memberCount: 3 }] });

      render(<Sidebar />, { wrapper: createWrapper() });
      const link = screen.getByRole('link', { name: testConv.title });
      expect(link.querySelector('svg.lucide-users')).toBeInTheDocument();
    });

    it('marks a pinned conversation that has other members with the users icon', () => {
      mockConversationsHook({ data: [{ ...testConv, pinned: true, memberCount: 2 }] });

      render(<Sidebar />, { wrapper: createWrapper() });
      const link = screen.getByRole('link', { name: testConv.title });
      expect(link.querySelector('svg.lucide-users')).toBeInTheDocument();
    });

    it('leaves a conversation with only its owner unmarked', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const link = screen.getByRole('link', { name: testConv.title });
      expect(link.querySelector('svg.lucide-users')).not.toBeInTheDocument();
    });

    it('shows empty state when no conversations', () => {
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });

    it('displays conversations from hook', () => {
      mockConversationsHook({
        data: [
          { ...testConv, title: 'First Chat' },
          {
            ...testConv,
            id: 'conv-2',
            title: 'Second Chat',
            privilege: 'write',
            createdAt: isoAt(TEST_DAY_START + DAY_MS),
            updatedAt: isoAt(TEST_DAY_START + DAY_MS),
          },
        ],
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.getByText('Second Chat')).toBeInTheDocument();
    });
  });

  describe('session expiry', () => {
    it('does not render conversations when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: [{ ...testConv, title: 'Stale Chat' }] });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Stale Chat')).not.toBeInTheDocument();
    });

    it('does not show Decrypting indicator when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.decryptingIndicator)).not.toBeInTheDocument();
    });

    it('shows NewChatButton when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
    });

    it('shows signup message when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('Sign up')).toBeInTheDocument();
      expect(screen.getByText(/to save conversations/)).toBeInTheDocument();
    });

    it('clears conversations query cache when session becomes unauthenticated', () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(
        ['chat', 'conversations'],
        [
          {
            id: 'conv-1',
            userId: 'user-1',
            title: 'Cached Chat',
            currentEpoch: 1,
            titleEpochNumber: 1,
            nextSequence: 1,
            createdAt: isoAt(TEST_DAY_START),
            updatedAt: isoAt(TEST_DAY_START),
            accepted: true,
            invitedByUsername: null,
            privilege: 'owner',
            muted: false,
            pinned: false,
          },
        ]
      );

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: undefined });

      function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      }
      Wrapper.displayName = 'TestWrapper';

      render(<Sidebar />, { wrapper: Wrapper });

      const cachedData = queryClient.getQueryData(['chat', 'conversations']);
      expect(cachedData).toBeUndefined();
    });
  });

  describe('active conversation marking', () => {
    const conversations = [
      { ...testConv, id: 'conv-1', title: 'First Chat' },
      { ...testConv, id: 'conv-2', title: 'Second Chat' },
    ];

    it('marks only the row at the current route as the current page', () => {
      useParamsMock.mockReturnValue({ id: 'conv-2' });
      routerPathnameMock.mockReturnValue('/chat/conv-2');
      mockConversationsHook({ data: conversations });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getAllByRole('link', { current: 'page' })).toHaveLength(1);
      expect(
        screen.getByRole('link', { name: 'Second Chat', current: 'page' })
      ).toBeInTheDocument();
    });

    it('styles the row matching the router-derived conversation id as the active row', () => {
      useParamsMock.mockReturnValue({ id: 'conv-2' });
      mockConversationsHook({ data: conversations });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('link', { name: 'Second Chat' }).parentElement).toHaveClass(
        'bg-background-subtle'
      );
      expect(screen.getByRole('link', { name: 'First Chat' }).parentElement).not.toHaveClass(
        'bg-background-subtle'
      );
    });

    it('marks no row as the current page when not on a conversation route', () => {
      useParamsMock.mockReturnValue({ id: undefined });
      routerPathnameMock.mockReturnValue('/');
      mockConversationsHook({ data: conversations });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
    });
  });

  describe('mobile behavior', () => {
    it('renders the sidebar as the phone drawer below the desktop band', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('dialog', { name: 'Conversations' })).toBe(
        screen.getByTestId(TEST_IDS.sidebar)
      );
    });

    it('keeps the phone drawer shut until it is opened', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes the mobile sidebar when the route changes', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });
      routerPathnameMock.mockReturnValue('/');

      const { rerender } = render(<Sidebar />, { wrapper: createWrapper() });
      expect(useUIStore.getState().mobileSidebarOpen).toBe(true);

      routerPathnameMock.mockReturnValue('/chat/conv-1');
      rerender(<Sidebar />);

      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes the mobile sidebar via the close button', async () => {
      const user = userEvent.setup();
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true });

      render(<Sidebar />, { wrapper: createWrapper() });

      await user.click(screen.getByRole('button', { name: /close sidebar/i }));

      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });
  });

  describe('scroll-lock cleanup', () => {
    it('clears stale pointer-events and block-interactivity classes after close', () => {
      vi.useFakeTimers();
      try {
        document.documentElement.classList.add('block-interactivity-7', 'keep-me');
        document.documentElement.style.pointerEvents = 'none';
        document.body.style.pointerEvents = 'none';
        useUIStore.setState({ mobileSidebarOpen: false });

        render(<Sidebar />, { wrapper: createWrapper() });

        act(() => {
          vi.advanceTimersByTime(350);
        });

        expect(document.documentElement.style.pointerEvents).toBe('');
        expect(document.body.style.pointerEvents).toBe('');
        expect(document.documentElement.classList.contains('block-interactivity-7')).toBe(false);
        // A non-matching class is preserved (the startsWith guard's false arm).
        expect(document.documentElement.classList.contains('keep-me')).toBe(true);
        document.documentElement.classList.remove('keep-me');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('notification offer', () => {
    function offerRegion(): HTMLElement {
      const region = screen.getByRole('button', { name: 'Enable' }).closest('[role="status"]');
      if (region === null) throw new Error('the notification offer is not a status region');
      return region as HTMLElement;
    }

    it('sits below the conversation list', () => {
      render(<Sidebar />, { wrapper: createWrapper() });

      const nav = screen.getByTestId(TEST_IDS.sidebarNav);
      expect(nav.compareDocumentPosition(offerRegion())).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING as number
      );
    });

    it('scrolls within at most half the body, so a short window keeps the list chrome clear', () => {
      render(<Sidebar />, { wrapper: createWrapper() });

      const holder = offerRegion().parentElement;
      expect(holder).toHaveClass('max-h-1/2');
      expect(holder).toHaveClass('overflow-y-auto');
      expect(holder?.lastElementChild).toBe(offerRegion());
    });

    it('leaves the rail stand-in unclipped, since only the card needs the cap', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });

      const holder = screen.getByRole('button', { name: 'Turn on notifications' }).parentElement;
      expect(holder).not.toHaveClass('overflow-y-auto');
    });

    it('sits above the account footer', () => {
      render(<Sidebar />, { wrapper: createWrapper() });

      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer.compareDocumentPosition(offerRegion())).toBe(
        Node.DOCUMENT_POSITION_PRECEDING as number
      );
    });

    it('carries the full card, not the compact button, while the sidebar is expanded', () => {
      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Turn on notifications' })
      ).not.toBeInTheDocument();
    });

    it('lays the rail stand-in out in a column, so it centres on the rail like the controls above it', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });

      const holder = screen.getByRole('button', { name: 'Turn on notifications' }).parentElement;
      expect(holder).toHaveClass('flex', 'flex-col');
    });

    it('leaves the open sidebar card in its plain scrolling holder', () => {
      render(<Sidebar />, { wrapper: createWrapper() });

      const holder = offerRegion().parentElement;
      expect(holder).not.toHaveClass('flex');
    });

    it('shrinks to a compact button in the rail, which is too narrow for the card', () => {
      useUIStore.setState({ sidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('button', { name: 'Turn on notifications' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    });

    it('reveals the card by expanding the sidebar when the compact button is pressed', async () => {
      const user = userEvent.setup();
      useUIStore.setState({ sidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });
      await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

      expect(useUIStore.getState().sidebarOpen).toBe(true);
      expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    });

    it('leaves the offer unanswered when the compact button expands the sidebar', async () => {
      const user = userEvent.setup();
      useUIStore.setState({ sidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });
      await user.click(screen.getByRole('button', { name: 'Turn on notifications' }));

      expect(dismissOffer).not.toHaveBeenCalled();
      expect(enableOffer).not.toHaveBeenCalled();
    });

    it('leaves the rail empty when the device is not owed the offer', () => {
      mockUseEnablePrompt.mockReturnValue({
        isVisible: false,
        isEnabling: false,
        enable: enableOffer,
        dismiss: dismissOffer,
      });
      useUIStore.setState({ sidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(
        screen.queryByRole('button', { name: 'Turn on notifications' })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    });

    it('renders inside the mobile drawer', () => {
      stubPhoneWidth();
      useUIStore.setState({ mobileSidebarOpen: true, sidebarOpen: false });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    });
  });

  describe('conversation data edge cases', () => {
    it('renders an empty list when the conversations hook returns undefined data', () => {
      mockConversationsHook({ data: undefined });

      render(<Sidebar />, { wrapper: createWrapper() });

      expect(screen.getByTestId(TEST_IDS.sidebar)).toBeInTheDocument();
    });
  });
});
