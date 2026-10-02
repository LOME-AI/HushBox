import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { friendlyErrorMessage, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/hooks/billing/use-conversation-budgets.js', () => ({
  useConversationBudgets: vi.fn(),
  useUpdateMemberBudget: vi.fn(),
  useUpdateConversationBudget: vi.fn(),
}));

vi.mock('@/hooks/realtime/use-conversation-links.js', () => ({
  useConversationLinks: vi.fn(),
}));

vi.mock('@/hooks/realtime/use-conversation-members.js', () => ({
  useConversationMembers: vi.fn(),
}));

import {
  useConversationBudgets,
  useUpdateMemberBudget,
  useUpdateConversationBudget,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets.js';
import { useConversationLinks } from '@/hooks/realtime/use-conversation-links.js';
import { useConversationMembers } from '@/hooks/realtime/use-conversation-members.js';
import { BudgetSettingsModal } from '@/components/chat/budget/budget-settings-modal.js';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client.js';

const mockUseConversationBudgets = vi.mocked(useConversationBudgets);
const mockUseUpdateMemberBudget = vi.mocked(useUpdateMemberBudget);
const mockUseUpdateConversationBudget = vi.mocked(useUpdateConversationBudget);
const mockUseConversationLinks = vi.mocked(useConversationLinks);
const mockUseConversationMembers = vi.mocked(useConversationMembers);

const mockMutateAsync = vi.fn();
const mockConvBudgetMutateAsync = vi.fn();

/**
 * The modal reads only `data` and `isLoading` from a query and only `mutateAsync` and
 * `isPending` from a mutation; the rest of TanStack's result is inert here, so the
 * partial object stands in for the whole result type.
 */
function partialResult<R>(fields: Partial<Record<keyof R, unknown>>): R {
  return fields as R;
}

type MemberBudgetRow = ConversationBudgetsResponse['members'][number];

function budgetRow(
  fields: Pick<MemberBudgetRow, 'memberId' | 'privilege' | 'capNanoUsd'> & Partial<MemberBudgetRow>
): MemberBudgetRow {
  return {
    userId: null,
    username: null,
    spentNanoUsd: '0',
    effectiveRemainingNanoUsd: fields.capNanoUsd,
    ...fields,
  };
}

function budgets(
  conversationCapNanoUsd: string,
  members: readonly MemberBudgetRow[],
  conversationSpentNanoUsd = '42500000000'
): ConversationBudgetsResponse {
  return {
    conversationCapNanoUsd,
    conversationSpentNanoUsd,
    ownerBalanceNanoUsd: '500000000000',
    members: [...members],
  };
}

// Bob (write, $25, $8 spent), an unnamed write link ($10), Carol (read, $5), a read link
// ($5) and a named write link ($0). Only Bob and the two write links can send.
const MEMBER_BUDGETS: readonly MemberBudgetRow[] = [
  budgetRow({
    memberId: 'mem-2',
    userId: 'user-2',
    username: 'bob',
    privilege: 'write',
    capNanoUsd: '25000000000',
    spentNanoUsd: '8000000000',
  }),
  budgetRow({ memberId: 'mem-3', privilege: 'write', capNanoUsd: '10000000000' }),
  budgetRow({
    memberId: 'mem-4',
    userId: 'user-4',
    username: 'carol',
    privilege: 'read',
    capNanoUsd: '5000000000',
  }),
  budgetRow({ memberId: 'mem-5', privilege: 'read', capNanoUsd: '5000000000' }),
  budgetRow({ memberId: 'mem-6', privilege: 'write', capNanoUsd: '0' }),
];

type Conversation = (typeof client.conversations)[':conversationId'];
type LinksBody = InferResponseType<Conversation['links']['$get'], 200>;
type MembersBody = InferResponseType<Conversation['members']['$get'], 200>;

type LinkRow = LinksBody['links'][number];
type RosterRow = MembersBody['members'][number];

function link(fields: Pick<LinkRow, 'id' | 'displayName' | 'privilege'>): LinkRow {
  return { revokedAt: null, expiresAt: null, createdAt: isoAt(TEST_DAY_START), ...fields };
}

function seat(
  fields: Pick<RosterRow, 'id' | 'userId' | 'username' | 'privilege' | 'linkId'>
): RosterRow {
  return { visibleFromEpoch: 1, joinedAt: isoAt(TEST_DAY_START), accepted: true, ...fields };
}

const LINKS: readonly LinkRow[] = [
  link({ id: 'link-0', displayName: 'Marta', privilege: 'read' }),
  link({ id: 'link-1', displayName: null, privilege: 'write' }),
  link({ id: 'link-2', displayName: 'Charlie', privilege: 'write' }),
];

const ROSTER: readonly RosterRow[] = [
  seat({ id: 'mem-1', userId: 'user-1', username: 'alice', privilege: 'owner', linkId: null }),
  seat({ id: 'mem-2', userId: 'user-2', username: 'bob', privilege: 'write', linkId: null }),
  seat({ id: 'mem-3', userId: null, username: null, privilege: 'write', linkId: 'link-1' }),
  seat({ id: 'mem-4', userId: 'user-4', username: 'carol', privilege: 'read', linkId: null }),
  seat({ id: 'mem-5', userId: null, username: null, privilege: 'read', linkId: 'link-0' }),
  seat({ id: 'mem-6', userId: null, username: null, privilege: 'write', linkId: 'link-2' }),
];

function serveBudgets(data: ConversationBudgetsResponse | undefined, isLoading = false): void {
  mockUseConversationBudgets.mockReturnValue(
    partialResult<ReturnType<typeof useConversationBudgets>>({ data, isLoading })
  );
}

function fieldValue(testId: string): string {
  const field = screen.getByTestId(testId);
  if (!(field instanceof HTMLInputElement)) throw new Error(`${testId} is not an input`);
  return field.value;
}

async function retype(testId: string, value: string): Promise<void> {
  const field = screen.getByTestId(testId);
  await userEvent.clear(field);
  if (value !== '') await userEvent.type(field, value);
}

describe('BudgetSettingsModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    currentUserPrivilege: 'owner',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serveBudgets(budgets('100000000000', MEMBER_BUDGETS));
    mockUseConversationLinks.mockReturnValue(
      partialResult<ReturnType<typeof useConversationLinks>>({ data: { links: LINKS } })
    );
    mockUseConversationMembers.mockReturnValue(
      partialResult<ReturnType<typeof useConversationMembers>>({ data: { members: ROSTER } })
    );
    mockUseUpdateMemberBudget.mockReturnValue(
      partialResult<ReturnType<typeof useUpdateMemberBudget>>({
        mutateAsync: mockMutateAsync,
        isPending: false,
      })
    );
    mockUseUpdateConversationBudget.mockReturnValue(
      partialResult<ReturnType<typeof useUpdateConversationBudget>>({
        mutateAsync: mockConvBudgetMutateAsync,
        isPending: false,
      })
    );
    mockMutateAsync.mockResolvedValue({ updated: true });
    mockConvBudgetMutateAsync.mockResolvedValue({ updated: true });
  });

  describe('header and copy', () => {
    it('is titled Budgets', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByRole('heading', { name: 'Budgets' })).toBeInTheDocument();
    });

    it('describes who pays and when members pay for themselves', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(
        screen.getByText(
          "You pay for members' replies up to these amounts. After that, each member pays from their own balance."
        )
      ).toBeInTheDocument();
    });

    it('says budgets are lifetime totals and a read-only link never spends', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(
        screen.getByText(
          'Budgets are totals for the life of this conversation, not monthly. A read-only link never spends.'
        )
      ).toBeInTheDocument();
    });
  });

  describe('the table', () => {
    it('heads its columns Who, Budget and Spent', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      const table = screen.getByRole('group', { name: 'Budgets' });
      const head = within(table).getByText('Who').closest('[aria-hidden="true"]');
      expect(head).toHaveTextContent(/^WhoBudgetSpent$/);
    });

    it('opens with the conversation row and its caption', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      const row = screen.getByTestId(TEST_IDS.budgetConversationSection);
      expect(row).toHaveTextContent('This conversation');
      expect(row).toHaveTextContent('The most you pay in total');
    });

    it('shows what the conversation has spent', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetTotalSpent)).toHaveTextContent('$42.50');
    });

    it('names an account member by account name with the privilege word', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      const row = screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-2'));
      expect(row).toHaveTextContent('Bob');
      expect(row).toHaveTextContent('Write');
    });

    it('names an admin member with the word Admin', () => {
      serveBudgets(
        budgets('100000000000', [
          budgetRow({
            memberId: 'mem-2',
            userId: 'user-2',
            username: 'bob',
            privilege: 'admin',
            capNanoUsd: '5000000000',
          }),
        ])
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-2'))).toHaveTextContent(
        'BobAdmin'
      );
    });

    it('names an unnamed link by its position in the links list', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-3'))).toHaveTextContent(
        'Guest Link #2'
      );
    });

    it('names a named link by its name', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-6'))).toHaveTextContent(
        'Charlie'
      );
    });

    it('says a link row joined through a link', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-6'))).toHaveTextContent(
        'Write · via a link'
      );
    });

    it('falls back to Guest Link while the links are not read yet', () => {
      mockUseConversationLinks.mockReturnValue(
        partialResult<ReturnType<typeof useConversationLinks>>({ data: undefined })
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-3'))).toHaveTextContent(
        'Guest Link'
      );
    });

    it('falls back to the budget row username and then to Unknown', () => {
      serveBudgets(
        budgets('0', [
          budgetRow({
            memberId: 'mem-90',
            userId: 'user-90',
            username: 'zoe',
            privilege: 'write',
            capNanoUsd: '5000000000',
          }),
          budgetRow({
            memberId: 'mem-91',
            userId: 'user-91',
            privilege: 'write',
            capNanoUsd: '5000000000',
          }),
        ])
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-90'))).toHaveTextContent('Zoe');
      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-91'))).toHaveTextContent(
        'Unknown'
      );
    });

    it('renders no row for a Read account member', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.queryByTestId(TEST_ID_BUILDERS.budgetMember('mem-4'))).not.toBeInTheDocument();
      expect(screen.queryByText('Carol')).not.toBeInTheDocument();
    });

    it('renders no row for a Read link', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.queryByTestId(TEST_ID_BUILDERS.budgetMember('mem-5'))).not.toBeInTheDocument();
      expect(screen.queryByText('Marta')).not.toBeInTheDocument();
    });

    it('shows what each member has spent', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      const row = screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-2'));
      expect(within(row).getByTestId(TEST_IDS.budgetSpent)).toHaveTextContent('$8.00');
    });

    it('reads each spent figure with the word Spent', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      const row = screen.getByTestId(TEST_ID_BUILDERS.budgetMember('mem-2'));
      expect(within(row).getByTestId(TEST_IDS.budgetSpent).parentElement).toHaveTextContent(
        /^Spent \$8\.00$/
      );
    });

    it('shows no member rows and no allocation when no member can send', () => {
      serveBudgets(budgets('50000000000', [], '1000000000'));
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetConversationSection)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.budgetTotalAllocated)).not.toBeInTheDocument();
    });

    it('shows the loading state while the budgets load', () => {
      serveBudgets(undefined, true);
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetLoading)).toBeInTheDocument();
    });
  });

  describe('the owner', () => {
    it('edits each budget in a dollar field named for its row', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByRole('textbox', { name: 'Budget for Bob, in dollars' })).toHaveValue(
        '25.00'
      );
      expect(
        screen.getByRole('textbox', { name: 'Budget for This conversation, in dollars' })
      ).toHaveValue('100.00');
    });

    it('reads the conversation budget into its field', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(fieldValue(TEST_IDS.budgetConversationInput)).toBe('100.00');
    });

    it('offers Cancel and Save budgets', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetCancelButton)).toHaveTextContent('Cancel');
      expect(screen.getByTestId(TEST_IDS.budgetSaveButton)).toHaveTextContent('Save budgets');
    });

    it('keeps Save disabled until a budget changes', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      const save = screen.getByTestId(TEST_IDS.budgetSaveButton);
      expect(save).toBeDisabled();

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      expect(save).toBeEnabled();
    });

    it('keeps Save disabled when the typed amount equals the saved one', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '25');

      expect(screen.getByTestId(TEST_IDS.budgetSaveButton)).toBeDisabled();
    });

    it('enables Save for a change of one cent', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '25.01');

      expect(screen.getByTestId(TEST_IDS.budgetSaveButton)).toBeEnabled();
    });

    it('reads Saving while the save is in flight', async () => {
      mockMutateAsync.mockReturnValue(
        new Promise(() => {
          /* never settles */
        })
      );
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      expect(await screen.findByText('Saving…')).toBeInTheDocument();
    });

    it('saves only the member rows that changed', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        memberId: 'mem-2',
        budgetCents: 3000,
      });
      expect(mockConvBudgetMutateAsync).not.toHaveBeenCalled();
    });

    it('does not save a row retyped to its own amount', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');
      await retype(TEST_ID_BUILDERS.budgetInput('mem-3'), '10');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'mem-2' }));
    });

    it('saves a changed conversation budget alone', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_IDS.budgetConversationInput, '200.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      await waitFor(() => {
        expect(mockConvBudgetMutateAsync).toHaveBeenCalledWith({
          conversationId: 'conv-123',
          budgetCents: 20_000,
        });
      });
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it('closes once the save succeeds', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      await waitFor(() => {
        expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('surfaces a BUDGET_BELOW_SPENT rejection with the shared copy, inline', async () => {
      mockMutateAsync.mockRejectedValue(new Error('BUDGET_BELOW_SPENT'));
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(friendlyErrorMessage('BUDGET_BELOW_SPENT'));
    });

    it('stays open when the save fails', async () => {
      mockMutateAsync.mockRejectedValue(new Error('BUDGET_BELOW_SPENT'));
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetSaveButton));

      await screen.findByRole('alert');
      expect(defaultProps.onOpenChange).not.toHaveBeenCalled();
    });

    it('closes on Cancel', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetCancelButton));

      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });

    it('discards edits on Cancel', async () => {
      const { rerender } = render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_IDS.budgetConversationInput, '999.00');

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetCancelButton));
      rerender(<BudgetSettingsModal {...defaultProps} />);

      expect(fieldValue(TEST_IDS.budgetConversationInput)).toBe('100.00');
    });

    it('saves on Enter in the last budget field', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);
      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.00');

      await userEvent.click(screen.getByTestId(TEST_ID_BUILDERS.budgetInput('mem-6')));
      await userEvent.keyboard('{Enter}');

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith({
          conversationId: 'conv-123',
          memberId: 'mem-2',
          budgetCents: 3000,
        });
      });
    });

    it('refuses letters in a budget field', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), 'abc');

      expect(fieldValue(TEST_ID_BUILDERS.budgetInput('mem-2'))).toBe('');
    });

    it('refuses a minus sign in a budget field', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '-5');

      expect(fieldValue(TEST_ID_BUILDERS.budgetInput('mem-2'))).toBe('5');
    });

    it('admits a partly typed decimal', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '30.');

      expect(fieldValue(TEST_ID_BUILDERS.budgetInput('mem-2'))).toBe('30.');
    });

    // A keystroke filter must let a value be typed, so it admits a bare separator that
    // names no amount yet; every figure is derived from the field on each keystroke.
    it('reads a lone decimal point as $0.00', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_ID_BUILDERS.budgetInput('mem-2'), '.');

      expect(fieldValue(TEST_ID_BUILDERS.budgetInput('mem-2'))).toBe('.');
      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent(
        '$10.00 of $100.00'
      );
    });
  });

  describe('the allocation', () => {
    it('reads the members total of the overall budget', () => {
      serveBudgets(
        budgets('20000000000', [
          budgetRow({ memberId: 'mem-2', privilege: 'write', capNanoUsd: '5000000000' }),
          budgetRow({ memberId: 'mem-3', privilege: 'write', capNanoUsd: '5000000000' }),
        ])
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      const line = screen.getByTestId(TEST_IDS.budgetTotalAllocated);
      expect(line).toHaveTextContent('Allocated to members');
      expect(line).toHaveTextContent('$10.00 of $20.00');
    });

    it('allocates no more than the overall budget', () => {
      serveBudgets(
        budgets('20000000000', [
          budgetRow({ memberId: 'mem-2', privilege: 'write', capNanoUsd: '25000000000' }),
          budgetRow({ memberId: 'mem-3', privilege: 'write', capNanoUsd: '10000000000' }),
        ])
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent(
        '$20.00 of $20.00'
      );
    });

    it('allocates $0.00 under a $0.00 overall budget', () => {
      serveBudgets(budgets('0', MEMBER_BUDGETS));
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent('$0.00 of $0.00');
    });

    it('leaves Read rows out of the members total', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent(
        '$35.00 of $100.00'
      );
    });

    it('follows the overall budget field as it is typed', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_IDS.budgetConversationInput, '12.34');

      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent(
        '$12.34 of $12.34'
      );
    });

    it('sums in exact integer money, not floating dollars', () => {
      serveBudgets(
        budgets('90071992547400020000000', [
          budgetRow({
            memberId: 'mem-2',
            privilege: 'write',
            capNanoUsd: '90071992547400010000000',
          }),
        ])
      );
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetTotalAllocated)).toHaveTextContent(
        '$90071992547400.01 of $90071992547400.02'
      );
    });
  });

  describe('the $0.00 note', () => {
    const ZERO_NOTE =
      "At $0.00 you pay for nothing here. Members pay from their own balance, and link guests can't send.";

    it('shows while the overall budget reads $0.00', () => {
      serveBudgets(budgets('0', MEMBER_BUDGETS));
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetZeroNote)).toHaveTextContent(ZERO_NOTE);
    });

    it('is absent while the overall budget is above $0.00', () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.budgetZeroNote)).not.toBeInTheDocument();
    });

    it('goes once the field is non-zero', async () => {
      serveBudgets(budgets('0', MEMBER_BUDGETS));
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_IDS.budgetConversationInput, '5');

      expect(screen.queryByTestId(TEST_IDS.budgetZeroNote)).not.toBeInTheDocument();
    });

    it('appears once the field is typed down to zero', async () => {
      render(<BudgetSettingsModal {...defaultProps} />);

      await retype(TEST_IDS.budgetConversationInput, '0.00');

      expect(screen.getByTestId(TEST_IDS.budgetZeroNote)).toBeInTheDocument();
    });
  });

  describe('a member who is not the owner', () => {
    const memberProps = { ...defaultProps, currentUserPrivilege: 'write' };

    beforeEach(() => {
      serveBudgets(
        budgets('100000000000', [
          budgetRow({
            memberId: 'mem-2',
            userId: 'user-2',
            username: 'bob',
            privilege: 'write',
            capNanoUsd: '25000000000',
            spentNanoUsd: '8000000000',
          }),
        ])
      );
    });

    it('reads the budgets as text', () => {
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetConversationValue)).toHaveTextContent('$100.00');
      expect(screen.getByTestId(TEST_ID_BUILDERS.budgetValue('mem-2'))).toHaveTextContent('$25.00');
    });

    it('reads each budget figure with the word Budget', () => {
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetConversationValue).parentElement).toHaveTextContent(
        /^Budget \$100\.00$/
      );
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.budgetValue('mem-2')).parentElement
      ).toHaveTextContent(/^Budget \$25\.00$/);
    });

    it('gets no budget fields', () => {
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('gets one Close and no Save', () => {
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetCancelButton)).toHaveTextContent('Close');
      expect(screen.queryByTestId(TEST_IDS.budgetSaveButton)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('closes on Close', async () => {
      render(<BudgetSettingsModal {...memberProps} />);

      await userEvent.click(screen.getByTestId(TEST_IDS.budgetCancelButton));

      await waitFor(() => {
        expect(memberProps.onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    // The server serves a non-owner their own row alone, so a members total here would
    // count one member and understate what the owner has allocated.
    it('shows no allocation line', () => {
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.queryByTestId(TEST_IDS.budgetTotalAllocated)).not.toBeInTheDocument();
    });

    it('sees the $0.00 note under a $0.00 overall budget', () => {
      serveBudgets(budgets('0', []));
      render(<BudgetSettingsModal {...memberProps} />);

      expect(screen.getByTestId(TEST_IDS.budgetZeroNote)).toBeInTheDocument();
    });
  });

  describe('anyone but the owner, admins included', () => {
    it.each(['write', 'admin'])('reads, as %s, that the owner pays for replies', (privilege) => {
      render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege={privilege} />);

      expect(
        screen.getByText(
          "The owner pays for members' replies up to these amounts. After that, each member pays from their own balance."
        )
      ).toBeInTheDocument();
    });

    it.each(['write', 'admin'])(
      'reads, as %s, the conversation row as the most the owner pays',
      (privilege) => {
        render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege={privilege} />);

        expect(screen.getByTestId(TEST_IDS.budgetConversationSection)).toHaveTextContent(
          'The most the owner pays in total'
        );
      }
    );

    it.each(['write', 'admin'])(
      'reads, as %s, that at $0.00 the owner pays for nothing',
      (privilege) => {
        serveBudgets(budgets('0', []));
        render(<BudgetSettingsModal {...defaultProps} currentUserPrivilege={privilege} />);

        expect(screen.getByTestId(TEST_IDS.budgetZeroNote)).toHaveTextContent(
          "At $0.00 the owner pays for nothing here. Members pay from their own balance, and link guests can't send."
        );
      }
    );
  });
});
