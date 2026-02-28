import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarContent } from './sidebar-content';
import { useUIStore } from '@/stores/ui';

// Mock @hushbox/shared with feature flags (partial mock)
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    FEATURE_FLAGS: {
      ...actual.FEATURE_FLAGS,
      PROJECTS_ENABLED: false,
    },
  };
});

// Mock router
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

// Mock useIsMobile (used by NewChatButton)
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
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

// Mock member hooks used by InboxContent
vi.mock('@/hooks/use-conversation-members', () => ({
  useAcceptMembership: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

describe('SidebarContent', () => {
  const mockConversations = [
    {
      id: 'conv-1',
      title: 'Test Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
  });

  it('renders NewChatButton', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
  });

  it('renders Search chats input when sidebar is open', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByText('Search chats')).toBeInTheDocument();
  });

  it('renders ChatList with conversations', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByText('Test Conversation')).toBeInTheDocument();
  });

  it('hides ProjectsLink when FEATURE_FLAGS.PROJECTS_ENABLED is false', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  it('renders in correct order: NewChat, Search, ChatList, Projects', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const content = screen.getByTestId('sidebar-nav');
    expect(content).toBeInTheDocument();
  });

  it('has aria-label on navigation', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const nav = screen.getByRole('navigation');
    expect(nav).toHaveAttribute('aria-label', 'Chat navigation');
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('hides search and labels when collapsed', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
      expect(screen.queryByText('Search chats')).not.toBeInTheDocument();
      // Projects is hidden by feature flag, so we just verify sidebar is collapsed
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
        privilege: 'owner',
      },
      {
        id: 'conv-2',
        title: 'Weekend Plans',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'write',
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
        privilege: 'write',
      },
    ];

    const mixedConvs = [...acceptedConvs, ...unacceptedConvs];

    it('shows plain heading when all conversations are accepted', () => {
      render(<SidebarContent conversations={acceptedConvs} />);
      expect(screen.getByText('Recent Chats')).toBeInTheDocument();
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

      expect(screen.getByTestId('inbox-content')).toBeInTheDocument();
      expect(screen.getByText('Team Standup')).toBeInTheDocument();
    });

    it('keeps chat list in DOM during slide (both panels render)', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      // Both panels exist in the DOM simultaneously for slide animation
      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.getByTestId('inbox-content')).toBeInTheDocument();
    });

    it('shows plain heading when no conversations have accepted field', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.getByText('Recent Chats')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });
  });
});
