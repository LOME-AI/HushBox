import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../hooks/use-conversation-budgets.js', () => ({
  useConversationBudgets: vi.fn(),
  useUpdateMemberBudget: vi.fn(),
  useUpdateConversationBudget: vi.fn(),
}));

import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
} from '../../hooks/use-conversation-budgets.js';
import { BudgetSettingsModal } from './budget-settings-modal.js';

const mockUseConversationBudgets = vi.mocked(useConversationBudgets);
const mockUseUpdateMemberBudget = vi.mocked(useUpdateMemberBudget);
const mockUseUpdateConversationBudget = vi.mocked(useUpdateConversationBudget);

const mockMutateAsync = vi.fn();
const mockConvBudgetMutateAsync = vi.fn();

const BUDGET_DATA_WITH_CONV_BUDGET = {
  conversationBudget: '100.00',
  totalSpent: '42.50',
  memberBudgets: [
    {
      memberId: 'mem-2',
      userId: 'user-2',
      linkId: null,
      privilege: 'write',
      budget: '25.00',
      spent: '8.00',
    },
    {
      memberId: 'mem-3',
      userId: null,
      linkId: 'link-1',
      privilege: 'read',
      budget: '10.00',
      spent: '0',
    },
  ],
};

const BUDGET_DATA = {
  conversationBudget: '0.00',
  totalSpent: '42.50',
  memberBudgets: [
    {
      memberId: 'mem-2',
      userId: 'user-2',
      linkId: null,
      privilege: 'write',
      budget: '25.00',
      spent: '8.00',
    },
    {
      memberId: 'mem-3',
      userId: null,
      linkId: 'link-1',
      privilege: 'read',
      budget: '10.00',
      spent: '0',
    },
  ],
};

const MEMBERS_DATA = [
  { id: 'mem-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
  { id: 'mem-2', userId: 'user-2', username: 'bob', privilege: 'write' },
  { id: 'mem-3', userId: null, linkId: 'link-1', username: null, privilege: 'read' },
];

describe('BudgetSettingsModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    members: MEMBERS_DATA,
    currentUserPrivilege: 'owner',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);
    mockUseUpdateMemberBudget.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateMemberBudget>);
    mockMutateAsync.mockResolvedValue({ updated: true });
    mockConvBudgetMutateAsync.mockResolvedValue({ updated: true });
    mockUseUpdateConversationBudget.mockReturnValue({
      mutateAsync: mockConvBudgetMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateConversationBudget>);
  });

  it('renders the modal with title', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const modal = screen.getByTestId('budget-settings-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent('Budget Settings');
  });

  it('shows loading state when budgets are loading', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-loading')).toBeInTheDocument();
  });

  it('displays total spent amount', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-total-spent')).toHaveTextContent('$42.50');
  });

  it('displays member budget rows with names', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-member-mem-2')).toHaveTextContent('Bob');
  });

  it('shows Guest Link label for link-based members', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-member-mem-3')).toHaveTextContent('Guest Link');
  });

  it('displays spent amounts for each member', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const row2 = screen.getByTestId('budget-member-mem-2');
    expect(within(row2).getByTestId('budget-spent')).toHaveTextContent('$8.00');
  });

  it('populates budget inputs with current values in dollars', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input2 = screen.getByTestId('budget-input-mem-2') as HTMLInputElement;
    expect(input2.value).toBe('25.00');
  });

  it('enables Save button only when values are changed', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const saveButton = screen.getByTestId('budget-save-button');
    expect(saveButton).toBeDisabled();

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    expect(saveButton).toBeEnabled();
  });

  it('calls updateMemberBudget for changed budgets on save', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-123',
      memberId: 'mem-2',
      budgetCents: 3000,
    });
  });

  it('does not call updateMemberBudget for unchanged budgets', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    // Only mem-2 changed, not mem-1 or mem-3
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'mem-2' }));
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('budget-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('displays total allocated amount', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$35.00');
  });

  it('renders conversation section with limit row', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    const section = screen.getByTestId('budget-conversation-section');
    expect(section).toBeInTheDocument();
    expect(section).toHaveTextContent('Conversation');
    expect(section).toHaveTextContent('Funding limit');
  });

  it('shows conversation budget input with value from data', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const input = screen.getByTestId('budget-conversation-input') as HTMLInputElement;
    expect(input.value).toBe('100.00');
  });

  it('shows budget values as plain text for non-owners', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.getByTestId('budget-conversation-value')).toHaveTextContent('$100.00');
    expect(screen.getByTestId('budget-value-mem-2')).toHaveTextContent('$25.00');
  });

  it('does not render input fields for non-owners', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.queryByTestId('budget-conversation-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('budget-input-mem-2')).not.toBeInTheDocument();
  });

  it('hides save button when privilege is not owner', () => {
    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    expect(screen.queryByTestId('budget-save-button')).not.toBeInTheDocument();
  });

  it('shows Close instead of Cancel when privilege is not owner', () => {
    render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege="write" />);

    const cancelButton = screen.getByTestId('budget-cancel-button');
    expect(cancelButton).toHaveTextContent('Close');
  });

  it('allows editing conversation budget for owner', async () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const convInput = screen.getByTestId('budget-conversation-input') as HTMLInputElement;
    expect(convInput).not.toHaveAttribute('readOnly');

    await userEvent.clear(convInput);
    await userEvent.type(convInput, '200.00');

    expect(convInput.value).toBe('200.00');
  });

  it('calls updateConversationBudget when conversation budget changed on save', async () => {
    mockUseConversationBudgets.mockReturnValue({
      data: BUDGET_DATA_WITH_CONV_BUDGET,
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    const convInput = screen.getByTestId('budget-conversation-input');
    await userEvent.clear(convInput);
    await userEvent.type(convInput, '200.00');

    await userEvent.click(screen.getByTestId('budget-save-button'));

    expect(mockConvBudgetMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-123',
      budgetCents: 20_000,
    });
  });

  it('shows subtitle explaining budget funding source', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.getByText(/The owner can fund AI usage for members/)).toBeInTheDocument();
    expect(screen.getByText(/When exhausted, members use their own balance/)).toBeInTheDocument();
  });

  it('renders action buttons side by side', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const cancelButton = screen.getByTestId('budget-cancel-button');
    expect(cancelButton.className).toContain('flex-1');
  });

  it('computes allocated as min of conversation budget and sum of member budgets', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: {
        conversationBudget: '20.00',
        totalSpent: '5.00',
        memberBudgets: [
          {
            memberId: 'mem-2',
            userId: 'user-2',
            linkId: null,
            privilege: 'write',
            budget: '25.00',
            spent: '3.00',
          },
          {
            memberId: 'mem-3',
            userId: null,
            linkId: 'link-1',
            privilege: 'read',
            budget: '10.00',
            spent: '2.00',
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    // sum(memberBudgets) = $35, convBudget = $20 → min = $20
    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$20.00');
  });

  it('uses sum of member budgets as allocated when conversation budget is zero', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    // BUDGET_DATA has conversationBudget: '0.00', memberBudgets sum: $35
    // 0 means "no limit" so allocated = sum = $35
    expect(screen.getByTestId('budget-total-allocated')).toHaveTextContent('$35.00');
  });

  it('shows total spent on the allocated row', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const allocatedRow = screen.getByTestId('budget-total-allocated');
    expect(allocatedRow).toHaveTextContent('$42.50 spent');
  });

  it('shows total spent inline on the conversation row', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const section = screen.getByTestId('budget-conversation-section');
    expect(section).toHaveTextContent('$42.50 spent');
  });

  it('renders member list in scrollable container', () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const scrollContainer = screen.getByTestId('budget-members-list');
    expect(scrollContainer.className).toContain('max-h-60');
    expect(scrollContainer.className).toContain('overflow-y-auto');
  });

  it('Enter on last budget input triggers save', async () => {
    render(<BudgetSettingsModal {...defaultProps} />);

    const input = screen.getByTestId('budget-input-mem-2');
    await userEvent.clear(input);
    await userEvent.type(input, '30.00');

    // Focus the last input (mem-3) and press Enter to trigger submit
    const lastInput = screen.getByTestId('budget-input-mem-3');
    lastInput.focus();

    lastInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        memberId: 'mem-2',
        budgetCents: 3000,
      });
    });
  });

  it('hides member budgets section when no non-owner members', () => {
    mockUseConversationBudgets.mockReturnValue({
      data: {
        conversationBudget: '50.00',
        totalSpent: '1.00',
        memberBudgets: [] as typeof BUDGET_DATA.memberBudgets,
      },
      isLoading: false,
    } as ReturnType<typeof useConversationBudgets>);

    render(<BudgetSettingsModal {...defaultProps} />);

    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.queryByTestId('budget-total-allocated')).not.toBeInTheDocument();
    // Conversation budget and total spent should still show
    expect(screen.getByTestId('budget-conversation-section')).toBeInTheDocument();
    expect(screen.getByTestId('budget-total-spent')).toBeInTheDocument();
  });
});
