import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileSidebar } from './mobile-sidebar';
import { useUIStore } from '@/stores/ui';

// Mock tanstack router
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { conversationId: string };
    className?: string;
  }) => (
    <a
      href={params ? to.replace('$conversationId', params.conversationId) : to}
      className={className}
      data-testid="chat-link"
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

// Mock the hooks
vi.mock('@/hooks/chat', () => ({
  useConversations: () => ({
    data: [],
    isLoading: false,
  }),
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

describe('MobileSidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ mobileSidebarOpen: false, sidebarOpen: true });
  });

  it('is hidden when mobileSidebarOpen is false', () => {
    render(<MobileSidebar />);
    expect(screen.queryByTestId('mobile-sidebar')).not.toBeInTheDocument();
  });

  it('is visible when mobileSidebarOpen is true', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    render(<MobileSidebar />);
    expect(screen.getByTestId('mobile-sidebar')).toBeInTheDocument();
  });

  it('displays LOME branding in header', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    render(<MobileSidebar />);
    expect(screen.getByText('LOME')).toBeInTheDocument();
    expect(screen.getByAltText('LOME Logo')).toBeInTheDocument();
  });

  it('renders logo as a link to /chat', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    render(<MobileSidebar />);
    const link = screen.getByRole('link', { name: /lome/i });
    expect(link).toHaveAttribute('href', '/chat');
  });

  it('contains sidebar navigation', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    render(<MobileSidebar />);
    expect(screen.getByTestId('sidebar-nav')).toBeInTheDocument();
  });

  it('contains sidebar footer', () => {
    useUIStore.setState({ mobileSidebarOpen: true });
    render(<MobileSidebar />);
    expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument();
  });
});
