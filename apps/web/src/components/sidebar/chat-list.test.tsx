import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { ChatList } from './chat-list';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="chat-link">
      {children}
    </a>
  ),
  useParams: () => ({ conversationId: undefined }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutate: vi.fn(),
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

describe('ChatList', () => {
  const mockConversations = [
    {
      id: 'conv-1',
      title: 'First Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner' as const,
      muted: false,
      pinned: false,
    },
    {
      id: 'conv-2',
      title: 'Second Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner' as const,
      muted: false,
      pinned: false,
    },
    {
      id: 'conv-3',
      title: 'Third Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner' as const,
      muted: false,
      pinned: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
  });

  it('renders list of conversations', () => {
    render(<ChatList conversations={mockConversations} />);
    expect(screen.getByText('First Conversation')).toBeInTheDocument();
    expect(screen.getByText('Second Conversation')).toBeInTheDocument();
    expect(screen.getByText('Third Conversation')).toBeInTheDocument();
  });

  it('renders empty state when no conversations for authenticated users', () => {
    render(<ChatList conversations={[]} isAuthenticated={true} />);
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders signup prompt when no conversations for trial users', () => {
    render(<ChatList conversations={[]} isAuthenticated={false} />);
    expect(screen.getByText(/Sign up/)).toBeInTheDocument();
    expect(screen.getByText(/to save conversations/)).toBeInTheDocument();
  });

  it('renders "Sign up" as a clickable link for trial users', () => {
    render(<ChatList conversations={[]} isAuthenticated={false} />);
    const signUpLink = screen.getByRole('link', { name: 'Sign up' });
    expect(signUpLink).toBeInTheDocument();
    expect(signUpLink).toHaveAttribute('href', '/signup');
  });

  it('renders "Sign up" link with primary styling', () => {
    render(<ChatList conversations={[]} isAuthenticated={false} />);
    const signUpLink = screen.getByRole('link', { name: 'Sign up' });
    expect(signUpLink).toHaveClass('text-primary');
  });

  it('does not render sign-up link for authenticated users', () => {
    render(<ChatList conversations={[]} isAuthenticated={true} />);
    expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders conversations as links', () => {
    render(<ChatList conversations={mockConversations} />);
    const links = screen.getAllByTestId(TEST_IDS.chatLink);
    expect(links).toHaveLength(3);
  });

  it('highlights active conversation', () => {
    render(<ChatList conversations={mockConversations} activeId="conv-2" />);
    const links = screen.getAllByTestId(TEST_IDS.chatLink);

    const activeLink = links[1]!;
    expect(activeLink.parentElement).toHaveClass('bg-sidebar-border');
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('shows icons only when collapsed', () => {
      render(<ChatList conversations={mockConversations} />);
      expect(screen.queryByText('First Conversation')).not.toBeInTheDocument();
      expect(screen.getAllByTestId(TEST_IDS.messageIcon)).toHaveLength(3);
    });

    it('renders empty placeholder (no signup link) for trial users when collapsed', () => {
      render(<ChatList conversations={[]} isAuthenticated={false} />);
      expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
      expect(screen.queryByText(/to save conversations/)).not.toBeInTheDocument();
    });

    it('renders empty placeholder (no copy) for authenticated users when collapsed', () => {
      render(<ChatList conversations={[]} isAuthenticated />);
      expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('renders as a list with proper role', () => {
      render(<ChatList conversations={mockConversations} />);
      expect(screen.getByRole('list')).toBeInTheDocument();
    });

    it('has aria-label for the conversation list', () => {
      render(<ChatList conversations={mockConversations} />);
      expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'Conversations');
    });

    it('uses a custom aria-label when provided', () => {
      render(<ChatList conversations={mockConversations} label="Pinned chats" />);
      expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'Pinned chats');
    });

    it('renders each conversation as a list item', () => {
      render(<ChatList conversations={mockConversations} />);
      const listItems = screen.getAllByRole('listitem');
      expect(listItems).toHaveLength(3);
    });
  });

  describe('infinite-scroll sentinel', () => {
    let observeMock: ReturnType<typeof vi.fn>;
    let disconnectMock: ReturnType<typeof vi.fn>;
    let observerCallback: IntersectionObserverCallback | null = null;
    let originalIntersectionObserver: typeof IntersectionObserver | undefined;

    beforeEach(() => {
      observerCallback = null;
      observeMock = vi.fn();
      disconnectMock = vi.fn();
      originalIntersectionObserver = globalThis.IntersectionObserver;
      class MockIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          observerCallback = callback;
        }
        observe = observeMock;
        disconnect = disconnectMock;
        unobserve = vi.fn();
        takeRecords = vi.fn(() => []);
        root: Element | null = null;
        rootMargin = '';
        thresholds: readonly number[] = [];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test env
      (globalThis as any).IntersectionObserver = MockIntersectionObserver;
    });

    afterEach(() => {
      if (originalIntersectionObserver) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test env
        (globalThis as any).IntersectionObserver = originalIntersectionObserver;
      }
    });

    it('renders a sentinel when hasMore is true', () => {
      const onLoadMore = vi.fn();
      render(<ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />);

      // Sentinel is the 4th list item (3 conversations + 1 sentinel).
      const items = screen.getAllByRole('listitem', { hidden: true });
      expect(items).toHaveLength(4);
    });

    it('does not render a sentinel when hasMore is false', () => {
      render(<ChatList conversations={mockConversations} hasMore={false} />);
      const items = screen.getAllByRole('listitem', { hidden: true });
      expect(items).toHaveLength(3);
    });

    it('observes the sentinel when hasMore + onLoadMore are set', () => {
      const onLoadMore = vi.fn();
      render(<ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />);

      expect(observeMock).toHaveBeenCalled();
    });

    it('does not observe when hasMore is false', () => {
      const onLoadMore = vi.fn();
      render(
        <ChatList conversations={mockConversations} hasMore={false} onLoadMore={onLoadMore} />
      );

      expect(observeMock).not.toHaveBeenCalled();
    });

    it('does not observe when onLoadMore is missing', () => {
      render(<ChatList conversations={mockConversations} hasMore />);
      expect(observeMock).not.toHaveBeenCalled();
    });

    it('calls onLoadMore when the sentinel intersects', () => {
      const onLoadMore = vi.fn();
      render(<ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />);

      expect(observerCallback).not.toBeNull();
      observerCallback!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );

      expect(onLoadMore).toHaveBeenCalled();
    });

    it('does not call onLoadMore when isIntersecting is false', () => {
      const onLoadMore = vi.fn();
      render(<ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />);

      observerCallback!(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );

      expect(onLoadMore).not.toHaveBeenCalled();
    });

    it('does not call onLoadMore while already loading more', () => {
      const onLoadMore = vi.fn();
      render(
        <ChatList conversations={mockConversations} hasMore isLoadingMore onLoadMore={onLoadMore} />
      );

      observerCallback!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );

      expect(onLoadMore).not.toHaveBeenCalled();
    });

    it('shows a spinner while loading more', () => {
      const onLoadMore = vi.fn();
      const { container } = render(
        <ChatList conversations={mockConversations} hasMore isLoadingMore onLoadMore={onLoadMore} />
      );

      expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('disconnects the observer on unmount', () => {
      const onLoadMore = vi.fn();
      const { unmount } = render(
        <ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />
      );

      unmount();
      expect(disconnectMock).toHaveBeenCalled();
    });

    it('handles missing entries gracefully (no isIntersecting key)', () => {
      const onLoadMore = vi.fn();
      render(<ChatList conversations={mockConversations} hasMore onLoadMore={onLoadMore} />);

      // Empty entries — entries[0] is undefined, optional chaining keeps us safe.
      observerCallback!([], {} as IntersectionObserver);

      expect(onLoadMore).not.toHaveBeenCalled();
    });
  });
});
