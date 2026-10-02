import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  TouchDeviceOverrideContext,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { RenameConversationDialog } from './rename-conversation-dialog';

/** Opens the dialog from a row menu's Rename item, as the chat row and the fork tabs do. */
function RenameFromMenu(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <TouchDeviceOverrideContext value={false}>
      <DropdownMenu>
        <DropdownMenuTrigger>More options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() => {
              setOpen(true);
            }}
          >
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameConversationDialog
        open={open}
        onOpenChange={setOpen}
        value="My Chat"
        onValueChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    </TouchDeviceOverrideContext>
  );
}

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

    await user.click(screen.getByTestId(TEST_IDS.cancelRenameButton));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('save button calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<RenameConversationDialog {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

    expect(onConfirm).toHaveBeenCalled();
  });

  it('save button is disabled when value is empty', () => {
    render(<RenameConversationDialog {...defaultProps} value="" />);

    expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
  });

  it('save button is disabled when value is only whitespace', () => {
    render(<RenameConversationDialog {...defaultProps} value="   " />);

    expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
  });

  it('does not render when open is false', () => {
    render(<RenameConversationDialog {...defaultProps} open={false} />);

    expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
  });

  it('focuses the name field when a menu item opens it', async () => {
    const user = userEvent.setup();
    render(<RenameFromMenu />);

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');

    await waitFor(() => {
      expect(screen.getByDisplayValue('My Chat')).toHaveFocus();
    });
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
