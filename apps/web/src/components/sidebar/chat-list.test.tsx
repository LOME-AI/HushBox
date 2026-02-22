import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatList } from './chat-list';
import { useUIStore } from '@/stores/ui';

// Mock Link component
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

// Mock member hooks used by ChatItem
vi.mock('@/hooks/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Mock chat hooks used by ChatItem
vi.mock('@/hooks/chat', () => ({
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
      privilege: 'owner',
    },
    {
      id: 'conv-2',
      title: 'Second Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner',
    },
    {
      id: 'conv-3',
      title: 'Third Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner',
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
    const links = screen.getAllByTestId('chat-link');
    expect(links).toHaveLength(3);
  });

  it('highlights active conversation', () => {
    render(<ChatList conversations={mockConversations} activeId="conv-2" />);
    const links = screen.getAllByTestId('chat-link');
    // The active styling is on the parent wrapper div, not the link

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
      expect(screen.getAllByTestId('message-icon')).toHaveLength(3);
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

    it('renders each conversation as a list item', () => {
      render(<ChatList conversations={mockConversations} />);
      const listItems = screen.getAllByRole('listitem');
      expect(listItems).toHaveLength(3);
    });
  });
});
