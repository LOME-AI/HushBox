import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatItem } from './chat-item';
import { useUIStore } from '@/stores/ui';

// Mock Link component
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
}));

describe('ChatItem', () => {
  const mockConversation = {
    id: 'conv-123',
    title: 'Test Conversation',
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('expanded state', () => {
    it('renders conversation title', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('links to conversation page', () => {
      render(<ChatItem conversation={mockConversation} />);
      const link = screen.getByTestId('chat-link');
      expect(link).toHaveAttribute('href', '/chat/conv-123');
    });

    it('truncates long titles', () => {
      const longTitle = {
        ...mockConversation,
        title: 'This is a very long conversation title that should be truncated',
      };
      render(<ChatItem conversation={longTitle} />);
      const title = screen.getByText(longTitle.title);
      expect(title).toHaveClass('truncate');
    });

    it('shows message icon', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId('message-icon')).toBeInTheDocument();
    });

    it('highlights when active', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      const link = screen.getByTestId('chat-link');
      expect(link).toHaveClass('bg-sidebar-border');
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('shows only icon when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId('message-icon')).toBeInTheDocument();
      expect(screen.queryByText('Test Conversation')).not.toBeInTheDocument();
    });
  });
});
