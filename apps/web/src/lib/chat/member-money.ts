import { MemberPrivilege, canSendMessages, parseNanoUSD } from '@hushbox/shared';
import { formatBalance } from '@/lib/billing/format';
import { joinWithAnd } from '@/lib/utils/join-with-and';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';

export interface MoneyFigure {
  readonly amount: string;
  readonly caption: string;
}

export interface PaneViewer {
  readonly isOwner: boolean;
  readonly memberId: string | null;
}

export interface BudgetSummary {
  readonly spent: string;
  readonly total: string;
  readonly funded: readonly string[];
}

export interface FundedLine {
  readonly visible: string;
  readonly more: number;
  readonly full: string;
}

const VISIBLE_FUNDED_NAMES = 3;

/** The owner's balance goes to the owner alone; the budgets read serves it to no one else. */
export function ownerMoney(
  budgets: ConversationBudgetsResponse | undefined,
  viewer: PaneViewer
): MoneyFigure | null {
  if (budgets === undefined || !viewer.isOwner || budgets.ownerBalanceNanoUsd === null) {
    return null;
  }
  return { amount: formatBalance(budgets.ownerBalanceNanoUsd), caption: 'balance' };
}

/**
 * The served effective remaining is the value admission gates on, so the
 * figure is never re-derived from cap and spend here.
 */
export function memberMoney(
  memberId: string,
  privilege: MemberPrivilege,
  budgets: ConversationBudgetsResponse | undefined
): MoneyFigure | null {
  if (budgets === undefined || !canSendMessages(privilege)) return null;
  const row = budgets.members.find((member) => member.memberId === memberId);
  if (row === undefined || parseNanoUSD(row.capNanoUsd) <= 0n) return null;
  return {
    amount: formatBalance(row.effectiveRemainingNanoUsd),
    caption: `of ${formatBalance(row.capNanoUsd)} left`,
  };
}

/** A Read member can never spend, so it is never named as funded, whatever its budget. */
export function budgetSummary(
  budgets: ConversationBudgetsResponse,
  nameOf: (row: ConversationBudgetsResponse['members'][number]) => string
): BudgetSummary {
  return {
    spent: formatBalance(budgets.conversationSpentNanoUsd),
    total: formatBalance(budgets.conversationCapNanoUsd),
    funded: budgets.members
      .filter(
        (member) =>
          canSendMessages(MemberPrivilege.parse(member.privilege)) &&
          parseNanoUSD(member.effectiveRemainingNanoUsd) > 0n
      )
      .map((member) => nameOf(member)),
  };
}

export function fundedLine(names: readonly string[]): FundedLine {
  const full = joinWithAnd(names);
  if (names.length <= VISIBLE_FUNDED_NAMES) return { visible: full, more: 0, full };
  return {
    visible: names.slice(0, VISIBLE_FUNDED_NAMES).join(', '),
    more: names.length - VISIBLE_FUNDED_NAMES,
    full,
  };
}
