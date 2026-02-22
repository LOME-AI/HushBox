import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RenameConversationDialog } from './rename-conversation-dialog';

describe('RenameConversationDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    value: 'My Chat',
    onValueChange: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders title and description', () => {
    render(<RenameConversationDialog {...defaultProps} />);

    expect(screen.getByText('Rename conversation')).toBeInTheDocument();
    expect(screen.getByText('Enter a new name for this conversation.')).toBeInTheDocument();
  });

  it('renders input with current value', () => {
    render(<RenameConversationDialog {...defaultProps} />);

    expect(screen.getByDisplayValue('My Chat')).toBeInTheDocument();
  });

  it('cancel button calls onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<RenameConversationDialog {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByTestId('cancel-rename-button'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('save button calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<RenameConversationDialog {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId('save-rename-button'));

    expect(onConfirm).toHaveBeenCalled();
  });

  it('save button is disabled when value is empty', () => {
    render(<RenameConversationDialog {...defaultProps} value="" />);

    expect(screen.getByTestId('save-rename-button')).toBeDisabled();
  });

  it('save button is disabled when value is only whitespace', () => {
    render(<RenameConversationDialog {...defaultProps} value="   " />);

    expect(screen.getByTestId('save-rename-button')).toBeDisabled();
  });

  it('does not render when open is false', () => {
    render(<RenameConversationDialog {...defaultProps} open={false} />);

    expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
  });

  it('Enter on input triggers confirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<RenameConversationDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByDisplayValue('My Chat');
    await user.click(input);
    await user.keyboard('{Enter}');

    expect(onConfirm).toHaveBeenCalled();
  });
});
