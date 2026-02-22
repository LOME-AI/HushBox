import type { APIRequestContext } from '@playwright/test';

const API_BASE = 'http://localhost:8787';

interface MemberBudget {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  privilege: string;
  budget: string;
  spent: string;
}

interface BudgetData {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: MemberBudget[];
  effectiveDollars: number;
  ownerTier: string;
  ownerBalanceDollars: number;
}

interface BalanceData {
  balance: string;
  freeAllowanceCents: number;
}

/**
 * Helper class wrapping budget and balance API calls for E2E test setup.
 * Accepts any APIRequestContext — instantiate with the right auth context
 * depending on which user needs to perform the operation.
 */
export class BudgetHelper {
  constructor(private request: APIRequestContext) {}

  async getBudgets(conversationId: string): Promise<BudgetData> {
    const response = await this.request.get(`${API_BASE}/api/budgets/${conversationId}`);
    if (!response.ok()) {
      throw new Error(`getBudgets failed: ${String(response.status())} ${await response.text()}`);
    }
    return (await response.json()) as BudgetData;
  }

  async setConversationBudget(conversationId: string, budgetCents: number): Promise<void> {
    const response = await this.request.patch(`${API_BASE}/api/budgets/${conversationId}/budget`, {
      data: { budgetCents },
    });
    if (!response.ok()) {
      throw new Error(
        `setConversationBudget failed: ${String(response.status())} ${await response.text()}`
      );
    }
  }

  async setMemberBudget(
    conversationId: string,
    memberId: string,
    budgetCents: number
  ): Promise<void> {
    const response = await this.request.patch(
      `${API_BASE}/api/budgets/${conversationId}/member/${memberId}`,
      { data: { budgetCents } }
    );
    if (!response.ok()) {
      throw new Error(
        `setMemberBudget failed: ${String(response.status())} ${await response.text()}`
      );
    }
  }

  async getBalance(): Promise<BalanceData> {
    const response = await this.request.get(`${API_BASE}/api/billing/balance`);
    if (!response.ok()) {
      throw new Error(`getBalance failed: ${String(response.status())} ${await response.text()}`);
    }
    return (await response.json()) as BalanceData;
  }

  /**
   * Find a member's conversation-member ID by their user ID.
   * Note: the budgets endpoint filters out the owner, so this only finds non-owner members.
   */
  async findMemberId(conversationId: string, userId: string): Promise<string> {
    const budgets = await this.getBudgets(conversationId);
    const member = budgets.memberBudgets.find((mb) => mb.userId === userId);
    if (!member) {
      throw new Error(
        `Member with userId ${userId} not found in conversation ${conversationId}. ` +
          `Available members: ${budgets.memberBudgets.map((mb) => mb.userId).join(', ')}`
      );
    }
    return member.memberId;
  }
}
