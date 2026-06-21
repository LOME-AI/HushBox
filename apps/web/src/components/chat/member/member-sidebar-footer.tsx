import * as React from 'react';
import { DollarSign } from 'lucide-react';
import { canManageLinks, effectiveBudgetCents, TEST_IDS } from '@hushbox/shared';
import { useConversationBudgets } from '@/hooks/billing/use-conversation-budgets';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';

interface BudgetData {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    /** '0.00' when no member_budgets row exists. */
    budget: string;
    spent: string;
  }[];
  ownerBalanceDollars: number;
}

/** @internal Exported for testing. */
export function computeBudgetSublabel(
  data: BudgetData,
  currentUserId: string,
  currentUserPrivilege: string
): string {
  const memberBudget = data.memberBudgets.find(
    (mb) =>
      mb.userId === currentUserId || mb.linkId === currentUserId || mb.memberId === currentUserId
  );
  const spentDollars = Number.parseFloat(memberBudget?.spent ?? '0');

  const budgetDollars =
    currentUserPrivilege === 'owner'
      ? data.ownerBalanceDollars
      : effectiveBudgetCents({
          conversationRemainingCents:
            Number.parseFloat(data.conversationBudget) * 100 -
            Number.parseFloat(data.totalSpent) * 100,
          memberRemainingCents:
            memberBudget === undefined
              ? 0
              : Number.parseFloat(memberBudget.budget) * 100 -
                Number.parseFloat(memberBudget.spent) * 100,
          ownerRemainingCents: data.ownerBalanceDollars * 100,
        }) / 100;

  const spent = `$${spentDollars.toFixed(2)}`;
  const budget = `$${budgetDollars.toFixed(2)}`;
  return `${spent} spent / ${budget} budget`;
}

interface MemberSidebarFooterProps {
  conversationId: string;
  currentUserId: string;
  currentUserPrivilege: string;
  collapsed: boolean;
  onBudgetSettingsClick?: (() => void) | undefined;
}

export function MemberSidebarFooter({
  conversationId,
  currentUserId,
  currentUserPrivilege,
  collapsed,
  onBudgetSettingsClick,
}: Readonly<MemberSidebarFooterProps>): React.JSX.Element {
  const isAdmin = canManageLinks(currentUserPrivilege);
  const { data } = useConversationBudgets(conversationId) as { data: BudgetData | undefined };

  const sublabel =
    data === undefined
      ? undefined
      : computeBudgetSublabel(data, currentUserId, currentUserPrivilege);

  return (
    <SidebarFooterBase
      icon={<DollarSign className="size-4" />}
      label={isAdmin ? 'Budget Settings' : 'Your Budget'}
      sublabel={sublabel}
      onClick={onBudgetSettingsClick}
      collapsed={collapsed}
      testId={TEST_IDS.memberBudget}
    />
  );
}
