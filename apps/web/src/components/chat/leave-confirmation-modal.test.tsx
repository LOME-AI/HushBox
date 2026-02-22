import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeaveConfirmationModal } from './leave-confirmation-modal';

describe('LeaveConfirmationModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    isOwner: false,
    onConfirm: vi.fn(),
  };

  it('renders title "Leave Conversation?"', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const title = screen.getByTestId('leave-confirmation-title');
    expect(title).toHaveTextContent('Leave Conversation?');
  });

  it('shows owner warning when isOwner is true', () => {
    render(<LeaveConfirmationModal {...defaultProps} isOwner={true} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).toHaveTextContent(
      'As the owner, leaving will delete all messages and remove all members.'
    );
  });

  it('shows non-owner warning when isOwner is false', () => {
    render(<LeaveConfirmationModal {...defaultProps} isOwner={false} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).toHaveTextContent("You will lose access to this conversation's messages.");
  });

  it('calls onConfirm when Leave button is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<LeaveConfirmationModal {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId('leave-confirmation-confirm'));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onOpenChange(false) when Cancel button is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<LeaveConfirmationModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('leave-confirmation-cancel'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) after confirming', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<LeaveConfirmationModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('leave-confirmation-confirm'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render when open is false', () => {
    render(<LeaveConfirmationModal {...defaultProps} open={false} />);

    expect(screen.queryByTestId('leave-confirmation-modal')).not.toBeInTheDocument();
  });

  it('has destructive styling on warning banner', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).toHaveClass('bg-destructive/10');
    expect(warning).toHaveClass('text-destructive');
  });

  it('has destructive variant on Leave button', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const confirmButton = screen.getByTestId('leave-confirmation-confirm');
    expect(confirmButton).toHaveTextContent('Leave');
  });

  it('has outline variant on Cancel button', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const cancelButton = screen.getByTestId('leave-confirmation-cancel');
    expect(cancelButton).toHaveTextContent('Cancel');
  });
});
