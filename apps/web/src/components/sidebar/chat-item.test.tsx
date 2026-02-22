import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatItem } from './chat-item';
import { useUIStore } from '@/stores/ui';

// Mock Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { id: string };
    className?: string;
    onClick?: () => void;
  }) => (
    <a
      href={params ? to.replace('$id', params.id) : to}
      className={className}
      data-testid="chat-link"
      onClick={onClick}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

// Mock crypto — encryptMessageForStorage returns a known Uint8Array
const MOCK_ENCRYPTED_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('@hushbox/crypto', () => ({
  encryptMessageForStorage: vi.fn(() => MOCK_ENCRYPTED_BYTES),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: vi.fn(() => 'bW9jay1lbmNyeXB0ZWQ'),
  };
});

// Mock epoch-key-cache — return a fake epoch private key
const MOCK_EPOCH_KEY = new Uint8Array([99, 88, 77]);
vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => MOCK_EPOCH_KEY),
}));

// Mock chat hooks
const mockDeleteMutate = vi.fn();
const mockUpdateMutate = vi.fn();

vi.mock('@/hooks/chat', () => ({
  useDeleteConversation: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

// Mock leave conversation hook
const mockLeaveMutate = vi.fn();
vi.mock('@/hooks/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutate: mockLeaveMutate,
    isPending: false,
  }),
}));

describe('ChatItem', () => {
  const mockConversation = {
    id: 'conv-123',
    title: 'Test Conversation',
    currentEpoch: 2,
    updatedAt: new Date().toISOString(),
    privilege: 'owner',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutate.mockClear();
    mockUpdateMutate.mockClear();
    mockLeaveMutate.mockClear();
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
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

    it('renders lock icon with muted style when title is Decrypting...', () => {
      const decryptingConversation = { ...mockConversation, title: 'Decrypting...' };
      render(<ChatItem conversation={decryptingConversation} />);
      expect(screen.getByTestId('decrypting-title')).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toHaveClass('text-muted-foreground');
    });

    it('hides message icon when expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId('message-icon')).not.toBeInTheDocument();
    });

    it('highlights when active', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      const link = screen.getByTestId('chat-link');
      // The active styling is on the parent wrapper div, not the link
      expect(link.parentElement).toHaveClass('bg-sidebar-border');
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

    it('hides more options button when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId('chat-item-more-button')).not.toBeInTheDocument();
    });
  });

  describe('actions dropdown', () => {
    it('shows more options button when sidebar is expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId('chat-item-more-button')).toBeInTheDocument();
    });

    it('opens dropdown menu on more button click', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('prevents navigation when clicking more button', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      const moreButton = screen.getByTestId('chat-item-more-button');
      await user.click(moreButton);

      // Dropdown should be open, link navigation should not have occurred
      expect(screen.getByText('Rename')).toBeInTheDocument();
    });
  });

  describe('delete action', () => {
    it('shows delete confirmation dialog when delete is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));

      expect(screen.getByText('Delete conversation?')).toBeInTheDocument();
      expect(screen.getByText(/This will permanently delete/)).toBeInTheDocument();
    });

    it('calls delete mutation when confirmed', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId('confirm-delete-button'));

      expect(mockDeleteMutate).toHaveBeenCalledWith('conv-123', expect.any(Object));
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId('cancel-delete-button'));

      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
      expect(mockDeleteMutate).not.toHaveBeenCalled();
    });
  });

  describe('rename action', () => {
    it('shows rename dialog when rename is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      expect(screen.getByText('Rename conversation')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test Conversation')).toBeInTheDocument();
    });

    it('calls update mutation with encrypted title and titleEpochNumber when saved', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId('save-rename-button'));

      expect(mockUpdateMutate).toHaveBeenCalledWith(
        {
          conversationId: 'conv-123',
          data: { title: 'bW9jay1lbmNyeXB0ZWQ', titleEpochNumber: 2 },
        },
        expect.any(Object)
      );
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));
      await user.click(screen.getByTestId('cancel-rename-button'));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
      expect(mockUpdateMutate).not.toHaveBeenCalled();
    });

    it('disables save button when title is empty', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);

      expect(screen.getByTestId('save-rename-button')).toBeDisabled();
    });
  });

  describe('non-owner actions', () => {
    const nonOwnerConversation = {
      ...mockConversation,
      privilege: 'write',
    };

    it('shows Leave instead of Rename and Delete for non-owner', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('shows Leave for read privilege', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, privilege: 'read' }} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    });

    it('shows Leave for admin privilege', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, privilege: 'admin' }} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('opens leave confirmation modal when Leave is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
    });

    it('calls leave mutation when confirmed', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('leave-confirmation-confirm'));

      expect(mockLeaveMutate).toHaveBeenCalledWith(
        { conversationId: 'conv-123' },
        expect.any(Object)
      );
    });

    it('does not call leave mutation when cancelled', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('leave-confirmation-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('leave-confirmation-modal')).not.toBeInTheDocument();
      });
      expect(mockLeaveMutate).not.toHaveBeenCalled();
    });

    it('shows Rename and Delete for owner privilege', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId('chat-item-more-button'));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.queryByText('Leave')).not.toBeInTheDocument();
    });
  });
});
