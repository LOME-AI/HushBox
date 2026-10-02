import { describe, it, expect, vi } from 'vitest';
import {
  budgetSummary,
  fundedLine,
  memberMoney,
  ownerMoney,
  type PaneViewer,
} from '@/lib/chat/member-money';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';

type BudgetMemberRow = ConversationBudgetsResponse['members'][number];

function memberRow(overrides: Partial<BudgetMemberRow> & { memberId: string }): BudgetMemberRow {
  return {
    userId: `user-${overrides.memberId}`,
    username: overrides.memberId,
    privilege: 'write',
    capNanoUsd: '5000000000',
    spentNanoUsd: '0',
    effectiveRemainingNanoUsd: '5000000000',
    ...overrides,
  };
}

function budgetsWith(overrides: Partial<ConversationBudgetsResponse>): ConversationBudgetsResponse {
  return {
    conversationCapNanoUsd: '40000000000',
    conversationSpentNanoUsd: '9610000000',
    ownerBalanceNanoUsd: '12480000000',
    members: [],
    ...overrides,
  };
}

const BUDGETS_NOT_YET_READ: ConversationBudgetsResponse | undefined = undefined;
const OWNER_VIEWER: PaneViewer = { isOwner: true, memberId: 'member-owner' };
const MEMBER_VIEWER: PaneViewer = { isOwner: false, memberId: 'member-bob' };

describe('ownerMoney', () => {
  it('shows the owner their balance with the caption "balance"', () => {
    expect(ownerMoney(budgetsWith({}), OWNER_VIEWER)).toEqual({
      amount: '$12.48',
      caption: 'balance',
    });
  });

  it('withholds the owner balance from a non-owner viewer', () => {
    expect(ownerMoney(budgetsWith({}), MEMBER_VIEWER)).toBeNull();
  });

  it('formats a negative owner balance with a minus', () => {
    expect(ownerMoney(budgetsWith({ ownerBalanceNanoUsd: '-500000000' }), OWNER_VIEWER)).toEqual({
      amount: '-$0.50',
      caption: 'balance',
    });
  });

  it('has no figure before the budgets read arrives', () => {
    expect(ownerMoney(BUDGETS_NOT_YET_READ, OWNER_VIEWER)).toBeNull();
  });

  it('has no figure when the budgets read serves no owner balance', () => {
    expect(ownerMoney(budgetsWith({ ownerBalanceNanoUsd: null }), OWNER_VIEWER)).toBeNull();
  });
});

describe('memberMoney', () => {
  it('shows a write member their effective remaining of their budget', () => {
    const budgets = budgetsWith({
      members: [
        memberRow({
          memberId: 'member-bob',
          capNanoUsd: '5000000000',
          effectiveRemainingNanoUsd: '3200000000',
        }),
      ],
    });

    expect(memberMoney('member-bob', 'write', budgets)).toEqual({
      amount: '$3.20',
      caption: 'of $5.00 left',
    });
  });

  it('shows an admin member their effective remaining of their budget', () => {
    const budgets = budgetsWith({
      members: [
        memberRow({
          memberId: 'member-carol',
          privilege: 'admin',
          capNanoUsd: '2000000000',
          effectiveRemainingNanoUsd: '1500000000',
        }),
      ],
    });

    expect(memberMoney('member-carol', 'admin', budgets)).toEqual({
      amount: '$1.50',
      caption: 'of $2.00 left',
    });
  });

  it('shows no figure for a read member with a budget', () => {
    const budgets = budgetsWith({
      members: [memberRow({ memberId: 'member-dave', privilege: 'read' })],
    });

    expect(memberMoney('member-dave', 'read', budgets)).toBeNull();
  });

  it('shows no figure for a member whose budget is zero', () => {
    const budgets = budgetsWith({
      members: [
        memberRow({ memberId: 'member-bob', capNanoUsd: '0', effectiveRemainingNanoUsd: '0' }),
      ],
    });

    expect(memberMoney('member-bob', 'write', budgets)).toBeNull();
  });

  it('shows no figure for a member the budgets read does not carry', () => {
    const budgets = budgetsWith({ members: [memberRow({ memberId: 'member-bob' })] });

    expect(memberMoney('member-erin', 'write', budgets)).toBeNull();
  });

  it('has no figure before the budgets read arrives', () => {
    expect(memberMoney('member-bob', 'write', BUDGETS_NOT_YET_READ)).toBeNull();
  });
});

describe('budgetSummary', () => {
  const names: Record<string, string> = {
    'member-bob': 'Bob',
    'member-carol': 'Carol',
    'member-dave': 'Dave',
  };
  const nameOf = (row: BudgetMemberRow): string => names[row.memberId] ?? row.memberId;

  it('gives the conversation spend of its overall budget', () => {
    const summary = budgetSummary(budgetsWith({}), nameOf);

    expect({ spent: summary.spent, total: summary.total }).toEqual({
      spent: '$9.61',
      total: '$40.00',
    });
  });

  it('names the funded members in the budgets read order', () => {
    const budgets = budgetsWith({
      members: [
        memberRow({ memberId: 'member-dave' }),
        memberRow({ memberId: 'member-carol', effectiveRemainingNanoUsd: '0' }),
        memberRow({ memberId: 'member-bob' }),
      ],
    });

    expect(budgetSummary(budgets, nameOf).funded).toEqual(['Dave', 'Bob']);
  });

  it('names no member whose effective remaining is negative', () => {
    const budgets = budgetsWith({
      members: [memberRow({ memberId: 'member-bob', effectiveRemainingNanoUsd: '-10000000' })],
    });

    expect(budgetSummary(budgets, nameOf).funded).toEqual([]);
  });

  it('never names a read member, whatever its budget', () => {
    const budgets = budgetsWith({
      members: [
        memberRow({ memberId: 'member-dave', privilege: 'read' }),
        memberRow({ memberId: 'member-bob' }),
      ],
    });

    expect(budgetSummary(budgets, nameOf).funded).toEqual(['Bob']);
  });

  it('hands the naming function the funded member row itself', () => {
    const bob = memberRow({ memberId: 'member-bob' });
    const nameRow = vi.fn((row: BudgetMemberRow): string => row.memberId);

    budgetSummary(budgetsWith({ members: [bob] }), nameRow);

    expect(nameRow).toHaveBeenCalledWith(bob);
  });

  it('names nobody when the overall budget is zero', () => {
    const budgets = budgetsWith({
      conversationCapNanoUsd: '0',
      conversationSpentNanoUsd: '0',
      members: [
        memberRow({ memberId: 'member-bob', effectiveRemainingNanoUsd: '0' }),
        memberRow({ memberId: 'member-carol', effectiveRemainingNanoUsd: '0' }),
      ],
    });

    expect(budgetSummary(budgets, nameOf).funded).toEqual([]);
  });
});

describe('fundedLine', () => {
  const EIGHT_NAMES = [
    'Bob',
    'Charlie',
    'Maximiliana Oyelaran-Whitcombe',
    'Dana',
    'Eun-ji',
    'Farouk',
    'Siobhán',
    'Tomasz',
  ];

  it('joins two names with "and"', () => {
    expect(fundedLine(['Bob', 'Charlie'])).toEqual({
      visible: 'Bob and Charlie',
      more: 0,
      full: 'Bob and Charlie',
    });
  });

  it('joins three names as "A, B and C"', () => {
    expect(fundedLine(['Bob', 'Charlie', 'Dana']).visible).toBe('Bob, Charlie and Dana');
  });

  it('shows a single name alone', () => {
    expect(fundedLine(['Bob'])).toEqual({ visible: 'Bob', more: 0, full: 'Bob' });
  });

  it('shows the first three of eight names', () => {
    expect(fundedLine(EIGHT_NAMES).visible).toBe('Bob, Charlie, Maximiliana Oyelaran-Whitcombe');
  });

  it('counts the names beyond the first three', () => {
    expect(fundedLine(EIGHT_NAMES).more).toBe(5);
  });

  it('joins every one of eight names in the full text', () => {
    expect(fundedLine(EIGHT_NAMES).full).toBe(
      'Bob, Charlie, Maximiliana Oyelaran-Whitcombe, Dana, Eun-ji, Farouk, Siobhán and Tomasz'
    );
  });

  it('is empty for no names', () => {
    expect(fundedLine([])).toEqual({ visible: '', more: 0, full: '' });
  });
});
