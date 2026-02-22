import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxContent } from './inbox-content';

const mockAcceptMutate = vi.fn();
const mockLeaveMutate = vi.fn();

vi.mock('@/hooks/use-conversation-members', () => ({
  useAcceptMembership: () => ({
    mutate: mockAcceptMutate,
    isPending: false,
  }),
  useLeaveConversation: () => ({
    mutate: mockLeaveMutate,
    isPending: false,
  }),
}));

// Mock router for navigation after accept
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

describe('InboxContent', () => {
  const mockInvites = [
    {
      id: 'conv-1',
      title: 'Design Team Chat',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      invitedByUsername: 'sarah',
    },
    {
      id: 'conv-2',
      title: 'Weekend Plans',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      invitedByUsername: 'mike',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders invite cards with titles', () => {
    render(<InboxContent conversations={mockInvites} />);

    expect(screen.getByText('Design Team Chat')).toBeInTheDocument();
    expect(screen.getByText('Weekend Plans')).toBeInTheDocument();
  });

  it('shows inviter username on each card', () => {
    render(<InboxContent conversations={mockInvites} />);

    expect(screen.getByText('@sarah')).toBeInTheDocument();
    expect(screen.getByText('@mike')).toBeInTheDocument();
  });

  it('renders accept and decline icon buttons for each invite', () => {
    render(<InboxContent conversations={mockInvites} />);

    const acceptButtons = screen.getAllByRole('button', { name: /accept/i });
    const declineButtons = screen.getAllByRole('button', { name: /decline/i });
    expect(acceptButtons).toHaveLength(2);
    expect(declineButtons).toHaveLength(2);
  });

  it('uses aria-label with conversation title for accessibility', () => {
    render(<InboxContent conversations={mockInvites} />);

    expect(screen.getByRole('button', { name: /accept design team chat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline design team chat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept weekend plans/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline weekend plans/i })).toBeInTheDocument();
  });

  it('calls accept mutation when check icon is clicked', async () => {
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /accept design team chat/i }));

    expect(mockAcceptMutate).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('shows confirmation modal when X icon is clicked', async () => {
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /decline design team chat/i }));

    expect(screen.getByText('Leave Conversation?')).toBeInTheDocument();
  });

  it('calls leave mutation when decline is confirmed', async () => {
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /decline design team chat/i }));

    const leaveButton = screen.getByTestId('leave-confirmation-confirm');
    await userEvent.click(leaveButton);

    expect(mockLeaveMutate).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('shows empty state when no invites', () => {
    render(<InboxContent conversations={[]} />);

    expect(screen.getByText('No pending invites')).toBeInTheDocument();
  });

  it('renders invite list with correct test id', () => {
    render(<InboxContent conversations={mockInvites} />);

    expect(screen.getByTestId('inbox-content')).toBeInTheDocument();
  });
});
