import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { useUIStore } from '@/stores/ui';

// Mock the chat hooks
vi.mock('@/hooks/chat', () => ({
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

import { useDecryptedConversations } from '@/hooks/chat';

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

// Mock member hooks used by ChatItem
vi.mock('@/hooks/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Mock @hushbox/shared with feature flags (partial mock)
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    FEATURE_FLAGS: {
      PROJECTS_ENABLED: false,
    },
  };
});

// Mock auth to return authenticated user
vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(() => ({
    data: {
      user: { id: 'user-1', email: 'test@example.com', username: 'test_user' },
      session: { id: 'session-1' },
    },
    isPending: false,
  })),
  signOutAndClearCache: vi.fn(),
}));

import { useSession } from '@/lib/auth';

const mockUseSession = vi.mocked(useSession);

// Mock router for SidebarContent children
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: () => ({ conversationId: undefined }),
}));

// Mock stability hooks for SidebarFooter
vi.mock('@/hooks/use-stable-balance', () => ({
  useStableBalance: () => ({
    displayBalance: '10.00',
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

// Mock useIsMobile to return false (desktop mode)
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  // eslint-disable-next-line sonarjs/function-return-type -- test wrapper returns children
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('Sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
    // Default mock: authenticated user
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
    // Default mock: return conversations
    mockUseDecryptedConversations.mockReturnValue({
      data: [
        {
          id: 'conv-1',
          userId: 'user-1',
          title: 'Test Chat',
          currentEpoch: 1,
          titleEpochNumber: 1,
          nextSequence: 1,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          accepted: true,
          invitedByUsername: null,
          privilege: 'owner',
        },
      ],
      isLoading: false,
    });
  });

  describe('desktop view', () => {
    it('renders aside element', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders sidebar header', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId('sidebar-header')).toBeInTheDocument();
    });

    it('renders SidebarFooter', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument();
    });

    it('has w-72 class when sidebar is open', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-72');
    });

    it('has w-12 class when sidebar is collapsed (rail mode)', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-12');
    });

    it('uses sidebar background color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('bg-sidebar');
    });

    it('uses sidebar border color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      // SidebarPanel uses border-r for left side
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
      expect(screen.getByTestId('sidebar-nav')).toBeInTheDocument();
    });

    it('renders NewChatButton', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    });

    it('renders Search chats input', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('Search chats')).toBeInTheDocument();
    });

    it('hides ProjectsLink when FEATURE_FLAGS.PROJECTS_ENABLED is false', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    });
  });

  describe('data fetching', () => {
    it('calls useDecryptedConversations hook', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(mockUseDecryptedConversations).toHaveBeenCalled();
    });

    it('shows decrypting state with lock icon when fetching', () => {
      mockUseDecryptedConversations.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId('decrypting-indicator')).toBeInTheDocument();
      expect(screen.getByTestId('decrypting-lock-icon')).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    });

    it('shows only lock icon without text when collapsed and loading', () => {
      useUIStore.setState({ sidebarOpen: false });
      mockUseDecryptedConversations.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId('decrypting-lock-icon')).toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
    });

    it('shows empty state when no conversations', () => {
      mockUseDecryptedConversations.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });

    it('displays conversations from hook', () => {
      mockUseDecryptedConversations.mockReturnValue({
        data: [
          {
            id: 'conv-1',
            userId: 'user-1',
            title: 'First Chat',
            currentEpoch: 1,
            titleEpochNumber: 1,
            nextSequence: 1,
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
            accepted: true,
            invitedByUsername: null,
            privilege: 'owner',
          },
          {
            id: 'conv-2',
            userId: 'user-1',
            title: 'Second Chat',
            currentEpoch: 1,
            titleEpochNumber: 1,
            nextSequence: 1,
            createdAt: '2024-01-02',
            updatedAt: '2024-01-02',
            accepted: true,
            invitedByUsername: null,
            privilege: 'write',
          },
        ],
        isLoading: false,
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
      mockUseDecryptedConversations.mockReturnValue({
        data: [
          {
            id: 'conv-1',
            userId: 'user-1',
            title: 'Stale Chat',
            currentEpoch: 1,
            titleEpochNumber: 1,
            nextSequence: 1,
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
            accepted: true,
            invitedByUsername: null,
            privilege: 'owner',
          },
        ],
        isLoading: false,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Stale Chat')).not.toBeInTheDocument();
    });

    it('does not show Decrypting indicator when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockUseDecryptedConversations.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
      expect(screen.queryByTestId('decrypting-indicator')).not.toBeInTheDocument();
    });

    it('shows NewChatButton when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockUseDecryptedConversations.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    });

    it('shows signup message when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockUseDecryptedConversations.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('Sign up')).toBeInTheDocument();
      expect(screen.getByText(/to save conversations/)).toBeInTheDocument();
    });

    it('clears conversations query cache when session becomes unauthenticated', () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      // Pre-populate the cache with stale conversation data
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
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
            accepted: true,
            invitedByUsername: null,
            privilege: 'owner',
          },
        ]
      );

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockUseDecryptedConversations.mockReturnValue({
        data: undefined,
        isLoading: false,
      });

      // eslint-disable-next-line sonarjs/function-return-type -- test wrapper returns children
      function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      }
      Wrapper.displayName = 'TestWrapper';

      render(<Sidebar />, { wrapper: Wrapper });

      // The conversations query cache should have been removed
      const cachedData = queryClient.getQueryData(['chat', 'conversations']);
      expect(cachedData).toBeUndefined();
    });
  });
});
