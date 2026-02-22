/**
 * Backend billing input builder.
 *
 * Consolidates all DB/Redis queries needed for `resolveBilling()` into a single
 * `ResolveBillingInput`. This is the async data-gathering layer that bridges
 * I/O to the pure billing decision function.
 */

import { effectiveBudgetCents, type ResolveBillingInput } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Redis } from '@upstash/redis';
import { getUserTierInfo } from './balance.js';
import { getReservedTotal, getGroupReservedTotals } from '../../lib/speculative-balance.js';
import { fetchModels, fetchZdrModelIds } from '../openrouter/index.js';
import { processModels } from '../models.js';
import { getConversationBudgets, computeGroupRemaining } from './budgets.js';

export interface MemberContext {
  memberId: string;
  ownerId: string;
}

/** Raw budget values needed for the post-reservation race guard in chat.ts. */
export interface GroupBudgetContext {
  conversationBudget: string;
  conversationSpent: string;
  memberBudget: string;
  memberSpent: string;
  ownerBalanceCents: number;
}

export interface BuildBillingResult {
  input: ResolveBillingInput;
  /** Raw user balance from DB (before Redis reservation subtraction). Needed for personal race guard. */
  rawUserBalanceCents: number;
  /** Present only for group billing paths. Used by the post-reservation race guard. */
  groupBudgetContext?: GroupBudgetContext;
}

/**
 * Gather all data needed for `resolveBilling()` from DB and Redis.
 *
 * For the personal path: queries user tier info and subtracts Redis reservations.
 * For the group path: additionally queries conversation budgets, owner tier info,
 * and group reservation totals.
 */
export interface BuildBillingInputParams {
  userId: string;
  model: string;
  estimatedMinimumCostCents: number;
  memberContext?: MemberContext;
  conversationId?: string;
}

export async function buildBillingInput(
  db: Database,
  redis: Redis,
  params: BuildBillingInputParams
): Promise<BuildBillingResult> {
  const { userId, model, estimatedMinimumCostCents, memberContext, conversationId } = params;
  // 1. User tier info + Redis reservations + model premium check (in parallel)
  const [userTierInfo, reservedCents, openrouterModels, zdrModelIds] = await Promise.all([
    getUserTierInfo(db, userId),
    getReservedTotal(redis, userId),
    fetchModels(),
    fetchZdrModelIds(),
  ]);

  const { premiumIds } = processModels(openrouterModels, zdrModelIds);
  const isPremiumModel = premiumIds.includes(model);

  const adjustedBalanceCents = userTierInfo.balanceCents - reservedCents;

  const input: ResolveBillingInput = {
    tier: userTierInfo.tier,
    balanceCents: adjustedBalanceCents,
    freeAllowanceCents: userTierInfo.freeAllowanceCents,
    isPremiumModel,
    estimatedMinimumCostCents,
  };

  // 2. Group path: if user is a member (not owner), gather group billing data
  if (memberContext !== undefined && conversationId !== undefined) {
    const [ownerTierInfo, reserved, budgets] = await Promise.all([
      getUserTierInfo(db, memberContext.ownerId),
      getGroupReservedTotals(redis, conversationId, memberContext.memberId, memberContext.ownerId),
      getConversationBudgets(db, conversationId),
    ]);

    const currentMemberBudget = budgets.memberBudgets.find(
      (mb) => mb.memberId === memberContext.memberId
    );

    const memberBudget = currentMemberBudget?.budget ?? '0.00';
    const memberSpent = currentMemberBudget?.spent ?? '0';

    const groupRemaining = computeGroupRemaining({
      conversationBudget: budgets.conversationBudget,
      conversationSpent: budgets.totalSpent,
      memberBudget,
      memberSpent,
      ownerBalanceCents: ownerTierInfo.balanceCents,
      reserved,
    });

    input.group = {
      effectiveCents: effectiveBudgetCents(groupRemaining),
      ownerTier: ownerTierInfo.tier,
      ownerBalanceCents: ownerTierInfo.balanceCents - reserved.payerTotal,
    };

    return {
      input,
      rawUserBalanceCents: userTierInfo.balanceCents,
      groupBudgetContext: {
        conversationBudget: budgets.conversationBudget,
        conversationSpent: budgets.totalSpent,
        memberBudget,
        memberSpent,
        ownerBalanceCents: ownerTierInfo.balanceCents,
      },
    };
  }

  return { input, rawUserBalanceCents: userTierInfo.balanceCents };
}
