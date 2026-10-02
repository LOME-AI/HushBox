import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, ERROR_CODES, friendlyErrorMessage } from '@hushbox/shared';
import { InboxContent } from './inbox-content';

// Stands in for TanStack Query's `mutate`: the per-call options object is where
// the row subscribes to the rejection, so the double must actually invoke it.
const mockAcceptMutate =
  vi.fn<
    (
      variables: { conversationId: string },
      options?: { onError?: (error: Error) => void; onSettled?: () => void }
    ) => void
  >();
const mockDeclineMutateAsync = vi.fn(() => Promise.resolve());

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useAcceptMembership: () => ({
    mutate: mockAcceptMutate,
    isPending: false,
  }),
  useDeclineInvitation: () => ({
    mutateAsync: mockDeclineMutateAsync,
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

    expect(mockAcceptMutate).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      expect.any(Object) as unknown as object
    );
  });

  it('shows the accept failure on the row that failed', async () => {
    mockAcceptMutate.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('boom'));
    });
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /accept design team chat/i }));

    expect(
      screen.getByText(friendlyErrorMessage(ERROR_CODES.INVITE_ACCEPT_FAILED))
    ).toBeInTheDocument();
  });

  it('leaves the other invitation rows unmarked when one accept fails', async () => {
    mockAcceptMutate.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('boom'));
    });
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /accept design team chat/i }));

    expect(
      screen.getAllByText(friendlyErrorMessage(ERROR_CODES.INVITE_ACCEPT_FAILED))
    ).toHaveLength(1);
  });

  it('keeps the failed invitation in the inbox', async () => {
    mockAcceptMutate.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('boom'));
    });
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /accept design team chat/i }));

    expect(screen.getByText('Design Team Chat')).toBeInTheDocument();
  });

  it('disables the accept button and marks it busy while the request is in flight', async () => {
    mockAcceptMutate.mockImplementation(() => {
      // Never settles: the row stays in its in-flight state.
    });
    render(<InboxContent conversations={mockInvites} />);

    const accept = screen.getByRole('button', { name: /accept design team chat/i });
    await userEvent.click(accept);

    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute('aria-busy', 'true');
  });

  it('leaves the other rows pressable while one accept is in flight', async () => {
    mockAcceptMutate.mockImplementation(() => {
      // Never settles: the row stays in its in-flight state.
    });
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /accept design team chat/i }));

    expect(screen.getByRole('button', { name: /accept weekend plans/i })).not.toBeDisabled();
  });

  it('re-enables the accept button once the request settles', async () => {
    mockAcceptMutate.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('boom'));
      options?.onSettled?.();
    });
    render(<InboxContent conversations={mockInvites} />);

    const accept = screen.getByRole('button', { name: /accept design team chat/i });
    await userEvent.click(accept);

    expect(accept).not.toBeDisabled();
  });

  it('clears a previous failure when the row is accepted again', async () => {
    mockAcceptMutate.mockImplementation((_variables, options) => {
      options?.onError?.(new Error('boom'));
      options?.onSettled?.();
    });
    render(<InboxContent conversations={mockInvites} />);

    const accept = screen.getByRole('button', { name: /accept design team chat/i });
    await userEvent.click(accept);
    await screen.findByText(friendlyErrorMessage(ERROR_CODES.INVITE_ACCEPT_FAILED));

    mockAcceptMutate.mockImplementation(() => {
      // Never settles: the retry is in flight, so no failure is showing.
    });
    await userEvent.click(accept);

    expect(
      screen.queryByText(friendlyErrorMessage(ERROR_CODES.INVITE_ACCEPT_FAILED))
    ).not.toBeInTheDocument();
  });

  it('shows confirmation modal when X icon is clicked', async () => {
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /decline design team chat/i }));

    expect(screen.getByText('Leave Conversation?')).toBeInTheDocument();
  });

  it('calls leave mutation when decline is confirmed', async () => {
    render(<InboxContent conversations={mockInvites} />);

    await userEvent.click(screen.getByRole('button', { name: /decline design team chat/i }));

    const leaveButton = screen.getByTestId(TEST_IDS.leaveConfirmationConfirm);
    await userEvent.click(leaveButton);

    expect(mockDeclineMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-1' });
  });

  it('shows empty state when no invites', () => {
    render(<InboxContent conversations={[]} />);

    expect(screen.getByText('No pending invites')).toBeInTheDocument();
  });

  it('renders invite list with correct test id', () => {
    render(<InboxContent conversations={mockInvites} />);

    expect(screen.getByTestId(TEST_IDS.inboxContent)).toBeInTheDocument();
  });

  it('omits the inviter line when no inviter username is present', () => {
    render(
      <InboxContent
        conversations={[
          {
            id: 'conv-3',
            title: 'Anonymous Invite',
            currentEpoch: 1,
            updatedAt: new Date().toISOString(),
          },
        ]}
      />
    );

    expect(screen.getByText('Anonymous Invite')).toBeInTheDocument();
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
  });

  it('dismisses the decline confirmation without declining', async () => {
    const user = userEvent.setup();
    render(<InboxContent conversations={mockInvites} />);

    await user.click(screen.getByRole('button', { name: 'Decline Design Team Chat' }));
    await screen.findByRole('alertdialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(mockDeclineMutateAsync).not.toHaveBeenCalled();
  });
});
