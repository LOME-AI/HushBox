import { nanoUsdToCents } from '@hushbox/shared';
import { postWalletBalanceSeed } from './dev-wallet-balance.js';
import { requireEnv } from './env.js';
import { idempotentPut } from './idempotent-request.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/** Nano-USD in one integer cent (1e-2 USD). */
const NANO_USD_PER_CENT = 10_000_000n;

/**
 * Full-precision decimal USD string from a canonical NanoUSD wire string, using
 * integer bigint math (no float, no `Number()` on the full nano amount). Shared
 * only exports a 2-decimal, cent-truncated `nanoUsdToDollarString`, which is
 * unusable here: specs assert `toBeGreaterThan(0)` on sub-cent spend, so any
 * sub-cent value must survive. Mirrors the dev endpoint's own
 * `nanoUsdToDecimalString` shape (nine fraction digits).
 */
export function nanoUsdWireToDollars(wire: string): string {
  const value = BigInt(wire);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000_000n;
  const fraction = (magnitude % 1_000_000_000n).toString().padStart(9, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** A dollar amount (integer cents) rendered as a canonical NanoUSD wire string. */
function centsToNanoUsdWire(cents: number): string {
  return (BigInt(Math.round(cents)) * NANO_USD_PER_CENT).toString();
}

interface MemberBudget {
  memberId: string;
  userId: string | null;
  username: string | null;
  privilege: string;
  /** Per-member cap, in dollars. Was `budget` (cents/dollars) in the legacy shape. */
  budget: string;
  /** Cumulative member spend, in dollars. */
  spent: string;
}

interface BudgetData {
  /** Per-conversation cap, in dollars. Legacy `conversationBudget`. */
  conversationBudget: string;
  /** Cumulative conversation spend, in dollars. Legacy `totalSpent`. */
  totalSpent: string;
  memberBudgets: MemberBudget[];
  /** Owner purchased-wallet balance, in dollars; null for a caller who is not the owner. */
  ownerBalanceDollars: number | null;
}

interface BalanceData {
  /** Purchased-wallet balance, in dollars. Legacy `balance`. */
  balance: string;
  /** Remaining daily free allowance, in whole cents. Legacy `freeAllowanceCents`. */
  freeAllowanceCents: number;
}

/** The new `GET /billing/balance` wire shape (money as NanoUSD strings). */
interface BalanceResponse {
  purchased: { balanceNanoUsd: string };
  free: { balanceNanoUsd: string };
  allowance: {
    day: string;
    limitNanoUsd: string;
    spentNanoUsd: string;
    remainingNanoUsd: string;
  };
}

/** A member row from the new `GET /conversations/:id/budgets` wire shape. */
interface MemberBudgetView {
  memberId: string;
  userId: string | null;
  username: string | null;
  privilege: string;
  capNanoUsd: string;
  spentNanoUsd: string;
  effectiveRemainingNanoUsd: string;
}

/** The new `GET /conversations/:id/budgets` wire shape (money as NanoUSD strings). */
interface BudgetsResponse {
  conversationCapNanoUsd: string;
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string | null;
  members: MemberBudgetView[];
}

/**
 * Helper class wrapping budget and balance API calls for E2E test setup.
 * Accepts any APIRequestContext — instantiate with the right auth context
 * depending on which user needs to perform the operation.
 */
export class BudgetHelper {
  private readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    // Wrap the injected context so budget calls retry a saturation sever even
    // when the caller passes a raw `page.request` (e.g. the multi-model tests).
    this.request = withRequestRetry(request);
  }

  async getBudgets(conversationId: string): Promise<BudgetData> {
    const response = await this.request.get(`${API_BASE}/conversations/${conversationId}/budgets`);
    await expectOkResponse(response, 'getBudgets');
    const data = (await response.json()) as BudgetsResponse;
    return {
      conversationBudget: nanoUsdWireToDollars(data.conversationCapNanoUsd),
      totalSpent: nanoUsdWireToDollars(data.conversationSpentNanoUsd),
      ownerBalanceDollars:
        data.ownerBalanceNanoUsd === null
          ? null
          : Number.parseFloat(nanoUsdWireToDollars(data.ownerBalanceNanoUsd)),
      memberBudgets: data.members.map((member) => ({
        memberId: member.memberId,
        userId: member.userId,
        username: member.username,
        privilege: member.privilege,
        budget: nanoUsdWireToDollars(member.capNanoUsd),
        spent: nanoUsdWireToDollars(member.spentNanoUsd),
      })),
    };
  }

  /**
   * Total spend recorded against a conversation, in dollars. Reads the same
   * `totalSpent` the budgets endpoint reports; poll it to wait for a turn's
   * post-flight billing to settle (the spend persists alongside the wallet
   * debit, just before the speculative reservation is released).
   */
  async getTotalSpent(conversationId: string): Promise<number> {
    const budgets = await this.getBudgets(conversationId);
    return Number.parseFloat(budgets.totalSpent);
  }

  async setConversationBudget(conversationId: string, budgetCents: number): Promise<void> {
    const response = await idempotentPut(
      this.request,
      `${API_BASE}/conversations/${conversationId}/budget`,
      { data: { capNanoUsd: centsToNanoUsdWire(budgetCents) } }
    );
    await expectOkResponse(response, 'setConversationBudget');
  }

  async setMemberBudget(
    conversationId: string,
    memberId: string,
    budgetCents: number
  ): Promise<void> {
    const response = await idempotentPut(
      this.request,
      `${API_BASE}/conversations/${conversationId}/member/${memberId}/budget`,
      { data: { capNanoUsd: centsToNanoUsdWire(budgetCents) } }
    );
    await expectOkResponse(response, 'setMemberBudget');
  }

  async getBalance(): Promise<BalanceData> {
    const response = await this.request.get(`${API_BASE}/billing/balance`);
    await expectOkResponse(response, 'getBalance');
    const data = (await response.json()) as BalanceResponse;
    return {
      balance: nanoUsdWireToDollars(data.purchased.balanceNanoUsd),
      // The daily free allowance remaining (legacy `freeAllowanceCents`) — the
      // free WALLET balance (`data.free`) is a distinct concept and not this.
      freeAllowanceCents: nanoUsdToCents(data.allowance.remainingNanoUsd),
    };
  }

  /**
   * Actual cost charged for a conversation's surviving AI messages, in micros
   * (millionths of a dollar). Sums `usage_records.cost` — written in the same
   * transaction as the wallet debit, so it equals the real wallet charge — but
   * scoped to one conversation. Unlike the global `getBalance()` delta, this is
   * immune to other tests charging the same shared per-project user in parallel,
   * which is the source of cost-reconciliation flake.
   */
  async getConversationChargedMicros(conversationId: string): Promise<number> {
    const response = await this.request.get(`${API_BASE}/dev/conversation-cost/${conversationId}`);
    await expectOkResponse(response, 'getConversationChargedMicros');
    const data = (await response.json()) as { cost: string };
    return Math.round(Number(data.cost) * 1_000_000);
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

/**
 * `llm_completions` rows behind a conversation's settled charges — one per
 * language charge, so a routed turn counts its classifier alongside its answer.
 * A non-ok read yields -1 so a caller polling for a settled count keeps polling
 * instead of failing on a read that raced settlement.
 */
export async function getLlmCompletionCount(
  request: APIRequestContext,
  conversationId: string
): Promise<number> {
  const response = await withRequestRetry(request).get(
    `${API_BASE}/dev/llm-completions-count/${conversationId}`
  );
  if (!response.ok()) return -1;
  const body = (await response.json()) as { count: number };
  return body.count;
}

/** The payer's served funding snapshot, in nano-USD. */
interface FundingSnapshotView {
  /** Hold-aware: what admission would gate the caller's own turn on. */
  readonly spendableNanoUsd: bigint;
  /** What active holds took off the figure, so `spendable + held` is hold-blind. */
  readonly heldNanoUsd: bigint;
  readonly payer: 'self' | 'owner';
}

/**
 * The payer's funding snapshot for the conversation being composed in — the
 * same figures the composer gates on, read as integers so a hold can be sized
 * without any float step. Pass no conversation id to read the caller's own
 * wallet outside any conversation.
 */
export async function getFundingSnapshot(
  request: APIRequestContext,
  conversationId?: string
): Promise<FundingSnapshotView> {
  const query = conversationId === undefined ? '' : `?conversationId=${conversationId}`;
  const response = await withRequestRetry(request).get(`${API_BASE}/billing/spendable${query}`);
  await expectOkResponse(response, 'getFundingSnapshot');
  const data = (await response.json()) as {
    spendableNanoUsd: string;
    heldNanoUsd: string;
    payer: 'self' | 'owner';
  };
  return {
    spendableNanoUsd: BigInt(data.spendableNanoUsd),
    heldNanoUsd: BigInt(data.heldNanoUsd),
    payer: data.payer,
  };
}

/**
 * The purchased wallet's ledger-truth balance as an integer — the figure
 * `setWalletBalance` writes, so a spec can restore exactly what it found.
 * Distinct from the funding snapshot above, which is hold-aware and carries the
 * negative-balance cushion.
 */
export async function getPurchasedBalanceNanoUsd(request: APIRequestContext): Promise<bigint> {
  const response = await withRequestRetry(request).get(`${API_BASE}/billing/balance`);
  await expectOkResponse(response, 'getPurchasedBalanceNanoUsd');
  const data = (await response.json()) as BalanceResponse;
  return BigInt(data.purchased.balanceNanoUsd);
}

/**
 * Set a user's wallet balance via the dev endpoint.
 * Used in E2E tests to manipulate wallet state for tier-switching scenarios.
 *
 * The request is constructed once, in the helper this delegates to; this
 * discards the amount it returns, and the money vocabulary's seed brands it.
 * A second construction would build the same request to the same route, so a
 * change to either would have to be made to both — which a text comparison
 * does not see, because the copy would be structural rather than textual.
 */
export async function setWalletBalance(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  balance: string
): Promise<void> {
  await postWalletBalanceSeed(request, email, walletType, balance);
}
