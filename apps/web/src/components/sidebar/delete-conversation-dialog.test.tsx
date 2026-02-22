import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteConversationDialog } from './delete-conversation-dialog';

describe('DeleteConversationDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'My Chat',
    onConfirm: vi.fn(),
  };

  it('renders title and description with conversation name', () => {
    render(<DeleteConversationDialog {...defaultProps} />);

    expect(screen.getByText('Delete conversation?')).toBeInTheDocument();
    expect(screen.getByText(/My Chat/)).toBeInTheDocument();
  });

  it('cancel button calls onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DeleteConversationDialog {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('cancel-delete-button'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('delete button calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DeleteConversationDialog {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId('confirm-delete-button'));

    expect(onConfirm).toHaveBeenCalled();
  });

  it('delete button has destructive variant', () => {
    render(<DeleteConversationDialog {...defaultProps} />);

    const deleteButton = screen.getByTestId('confirm-delete-button');
    expect(deleteButton).toHaveAttribute('data-variant', 'destructive');
  });

  it('does not render when open is false', () => {
    render(<DeleteConversationDialog {...defaultProps} open={false} />);

    expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
  });
});
