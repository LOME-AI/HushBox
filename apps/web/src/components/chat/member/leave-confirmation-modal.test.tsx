import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';

const TEMPLATE_SOURCES = import.meta.glob<string>('./leave-confirmation-modal.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The simulate-failure row renders only where `env.isLocalDev` holds.
vi.mock('@/lib/platform/env', () => ({
  env: { isLocalDev: true },
}));

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

  it('renders the owner warning on a raised surface, not as a muted hint', () => {
    render(<LeaveConfirmationModal {...defaultProps} isOwner={true} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).toHaveClass('bg-muted');
    expect(warning).not.toHaveClass('text-muted-foreground');
  });

  it('leaves the non-owner warning at hint weight', () => {
    render(<LeaveConfirmationModal {...defaultProps} isOwner={false} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).not.toHaveClass('bg-muted');
    expect(warning).toHaveClass('text-muted-foreground');
  });

  it('names the alert dialog with its visible title', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Leave Conversation?');
  });

  it('draws the warning as a notice', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    expect(screen.getByTestId('leave-confirmation-warning')).toHaveAttribute('data-slot', 'notice');
  });

  it('marks the warning with the warning tone', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    expect(screen.getByTestId('leave-confirmation-warning')).toHaveAttribute(
      'data-tone',
      'warning'
    );
  });

  it('leads the warning with the triangle', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const icon = screen.getByTestId('leave-confirmation-warning').querySelector('svg');
    expect(icon).toHaveClass('lucide-triangle-alert');
  });

  it('builds its warning from Notice, not Alert', () => {
    const sources = Object.values(TEMPLATE_SOURCES);

    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toMatch(/\bAlert\b/);
  });

  it('announces the owner warning politely rather than interrupting', () => {
    render(<LeaveConfirmationModal {...defaultProps} isOwner={true} />);

    expect(screen.getByTestId('leave-confirmation-warning')).toHaveAttribute('role', 'status');
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

  it('states the leave consequences without interrupting the screen reader', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    const warning = screen.getByTestId('leave-confirmation-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveClass('text-muted-foreground');
    expect(warning).not.toHaveClass('bg-destructive/10');
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

  it('offers the leave refusal a pure departure can meet', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    expect(screen.getByTestId(TEST_ID_BUILDERS.devSimulate('NOT_FOUND'))).toBeInTheDocument();
  });

  it('offers no rotation refusal, since a leave builds no rotation', () => {
    render(<LeaveConfirmationModal {...defaultProps} />);

    for (const code of ['ROTATION_REQUIRED', 'STALE_EPOCH', 'WRAP_SET_MISMATCH']) {
      expect(screen.queryByTestId(TEST_ID_BUILDERS.devSimulate(code))).not.toBeInTheDocument();
    }
  });
});
