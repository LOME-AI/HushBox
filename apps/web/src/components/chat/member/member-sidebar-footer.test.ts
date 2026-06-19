import { describe, it, expect } from 'vitest';
import { computeBudgetSublabel } from '@/components/chat/member/member-sidebar-footer';

interface MemberBudget {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  budget: string;
  spent: string;
}

function makeData(
  memberBudgets: MemberBudget[],
  ownerBalanceDollars = 200
): {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: MemberBudget[];
  ownerBalanceDollars: number;
} {
  return {
    conversationBudget: '100.00',
    totalSpent: '30.00',
    memberBudgets,
    ownerBalanceDollars,
  };
}

describe('computeBudgetSublabel', () => {
  it('uses owner balance as budget for owners', () => {
    const data = makeData(
      [{ memberId: 'm1', userId: 'u1', linkId: null, budget: '50.00', spent: '10.00' }],
      200
    );

    expect(computeBudgetSublabel(data, 'u1', 'owner')).toBe('$10.00 spent / $200.00 budget');
  });

  it('computes effective budget for non-owner members', () => {
    const data = makeData(
      [{ memberId: 'm3', userId: 'u3', linkId: null, budget: '50.00', spent: '15.00' }],
      200
    );

    // convRemaining=7000, memberRemaining=3500, ownerRemaining=20000 → 3500c → $35.00
    expect(computeBudgetSublabel(data, 'u3', 'write')).toBe('$15.00 spent / $35.00 budget');
  });

  it('matches budget row by linkId when currentUserId is a linkId', () => {
    const data = {
      conversationBudget: '100.00',
      totalSpent: '20.00',
      memberBudgets: [
        { memberId: 'guest', userId: null, linkId: 'link-abc', budget: '40.00', spent: '5.00' },
      ],
      ownerBalanceDollars: 200,
    };

    expect(computeBudgetSublabel(data, 'link-abc', 'write')).toBe('$5.00 spent / $35.00 budget');
  });

  it('treats a missing budget row as zero spent and zero member remaining', () => {
    const data = makeData(
      [{ memberId: 'other', userId: 'other-user', linkId: null, budget: '50.00', spent: '10.00' }],
      200
    );

    expect(computeBudgetSublabel(data, 'no-match', 'write')).toBe('$0.00 spent / $0.00 budget');
  });
});
