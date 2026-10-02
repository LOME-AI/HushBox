import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/hooks/realtime/use-user-search.js', () => ({
  useUserSearch: vi.fn(),
}));

import { MAX_CONVERSATION_MEMBERS, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { useUserSearch } from '@/hooks/realtime/use-user-search.js';
import { AddMemberModal } from '@/components/chat/member/add-member-modal';
import type { ComponentProps } from 'react';

const mockUseUserSearch = vi.mocked(useUserSearch);

type OnAddMember = ComponentProps<typeof AddMemberModal>['onAddMember'];

describe('AddMemberModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    onAddMember: vi.fn(),
  };

  async function submitAfter(
    choose: () => Promise<void>,
    onAddMember: Mock<OnAddMember> = vi.fn<OnAddMember>()
  ): Promise<Mock<OnAddMember>> {
    mockUseUserSearch.mockReturnValue({
      data: { users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }] },
      isLoading: false,
      // The dialog reads only `data`; the hook's declared return is the untyped
      // query result, so a whole one would restate fields nothing here reads.
    } as ReturnType<typeof useUserSearch>);
    render(<AddMemberModal {...defaultProps} onAddMember={onAddMember} />);
    await userEvent.type(screen.getByTestId(TEST_IDS.addMemberSearchInput), 'al');
    await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.addMemberResult('user-1')));
    await choose();
    await userEvent.click(screen.getByTestId(TEST_IDS.addMemberSubmitButton));
    return onAddMember;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserSearch.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);
  });

  it('renders search input when open', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-search-input')).toBeInTheDocument();
  });

  it('shows search results when query >= 2 chars', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [
          { id: 'user-1', username: 'alice123', publicKey: 'AQID' },
          { id: 'user-2', username: 'bob_smith', publicKey: 'BAIE' },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    expect(screen.getByTestId('add-member-result-user-1')).toBeInTheDocument();
    expect(screen.getByTestId('add-member-result-user-2')).toBeInTheDocument();
    expect(screen.getByText('Alice123')).toBeInTheDocument();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
  });

  it('selects a user when result is clicked', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(screen.getByTestId('add-member-selected')).toBeInTheDocument();
    expect(screen.getByTestId('add-member-selected')).toHaveTextContent('Alice123');
  });

  it('shows selected user info after selection', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    const selected = screen.getByTestId('add-member-selected');
    expect(selected).toHaveTextContent('Alice123');
  });

  it('chooses Write by default', () => {
    render(<AddMemberModal {...defaultProps} />);

    const write = screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('write'));
    expect(write).toHaveAttribute('aria-checked', 'true');
    expect(write).toHaveAttribute('data-state', 'on');
  });

  it('offers Read, Write and Admin in a group named Privilege', () => {
    render(<AddMemberModal {...defaultProps} />);

    const group = screen.getByRole('group', { name: 'Privilege' });
    const names = within(group)
      .getAllByRole('radio')
      .map((item) => item.textContent);
    expect(names).toEqual(['Read', 'Write', 'Admin']);
  });

  it('submits read after Read is pressed', async () => {
    const onAddMember = await submitAfter(async () => {
      await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('read')));
    });

    expect(onAddMember).toHaveBeenCalledWith(expect.objectContaining({ privilege: 'read' }));
  });

  it('keeps Write chosen when the chosen Write is pressed again', async () => {
    const onAddMember = await submitAfter(async () => {
      await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('write')));
    });

    expect(screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('write'))).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(onAddMember).toHaveBeenCalledWith(expect.objectContaining({ privilege: 'write' }));
  });

  it("clears a failed add's error when a different privilege is pressed", async () => {
    const failing = vi.fn<OnAddMember>().mockRejectedValue(new Error('refused'));
    await submitAfter(async () => {}, failing);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('read')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submits giveFullHistory from the checkbox carrying the history test id', async () => {
    const onAddMember = await submitAfter(async () => {
      const checkbox = screen.getByTestId(TEST_IDS.addMemberHistoryCheckbox);
      expect(checkbox).toHaveRole('checkbox');
      await userEvent.click(checkbox);
    });

    expect(onAddMember).toHaveBeenCalledWith(expect.objectContaining({ giveFullHistory: true }));
  });

  it('labels the search field Search by username', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByLabelText('Search by username')).toHaveAttribute(
      'data-testid',
      TEST_IDS.addMemberSearchInput
    );
  });

  it('disables Add Member button when no user selected', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-submit-button')).toBeDisabled();
  });

  it('enables Add Member button when user is selected', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(screen.getByTestId('add-member-submit-button')).toBeEnabled();
  });

  it('calls onAddMember with correct params on submit', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.addMemberPrivilege('admin')));

    await userEvent.click(screen.getByRole('checkbox'));

    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(defaultProps.onAddMember).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice123',
      publicKey: 'AQID',
      privilege: 'admin',
      giveFullHistory: true,
    });
  });

  it('closes modal after successful add', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));
    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('awaits an async onAddMember before closing', async () => {
    const onAddMember = vi.fn(() => Promise.resolve());
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} onAddMember={onAddMember} />);

    await userEvent.type(screen.getByTestId('add-member-search-input'), 'al');
    await userEvent.click(screen.getByTestId('add-member-result-user-1'));
    await userEvent.click(screen.getByTestId('add-member-submit-button'));

    expect(onAddMember).toHaveBeenCalledOnce();
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    render(<AddMemberModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('add-member-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('unchecked history checkbox by default', () => {
    render(<AddMemberModal {...defaultProps} />);

    expect(screen.getByTestId('add-member-history-checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('allows toggling history checkbox', async () => {
    render(<AddMemberModal {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it('clears search input when a user is selected', async () => {
    mockUseUserSearch.mockReturnValue({
      data: {
        users: [{ id: 'user-1', username: 'alice123', publicKey: 'AQID' }],
      },
      isLoading: false,
    } as ReturnType<typeof useUserSearch>);

    render(<AddMemberModal {...defaultProps} />);

    const input = screen.getByTestId('add-member-search-input');
    await userEvent.type(input, 'al');

    await userEvent.click(screen.getByTestId('add-member-result-user-1'));

    expect(input).toHaveValue('');
  });

  it('shows member limit alert and disables submit when at capacity', () => {
    render(<AddMemberModal {...defaultProps} memberCount={MAX_CONVERSATION_MEMBERS} />);

    expect(screen.getByText(/reached the maximum of 100 members/)).toBeInTheDocument();
    expect(screen.getByTestId('add-member-submit-button')).toBeDisabled();
  });

  it('does not show member limit alert when below capacity', () => {
    render(<AddMemberModal {...defaultProps} memberCount={50} />);

    expect(screen.queryByText(/reached the maximum of 100 members/)).not.toBeInTheDocument();
  });

  it('lays its actions out in one button row, Cancel before Add Member', async () => {
    const { buttonRowClass } = await import('@hushbox/ui/button-groups');
    render(<AddMemberModal {...defaultProps} />);

    const submitButton = screen.getByTestId('add-member-submit-button');
    const cancelButton = screen.getByTestId('add-member-cancel-button');

    const row = submitButton.parentElement;
    expect(row).toHaveClass(...buttonRowClass.split(' '));
    expect(cancelButton.parentElement).toBe(row);
    expect(cancelButton.compareDocumentPosition(submitButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
