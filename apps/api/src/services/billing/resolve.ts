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
import { fetchModels, processModels } from '@hushbox/shared/models';
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
  /** Raw free allowance from DB (before Redis reservation subtraction). Needed for free-tier race guard. */
  rawFreeAllowanceCents: number;
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
  models: string[];
  apiKey: string;
  memberContext?: MemberContext;
  conversationId?: string;
}

export interface BuildGuestBillingInputParams {
  ownerId: string;
  memberId: string;
  models: string[];
  apiKey: string;
  conversationId: string;
}

interface ResolveGroupRemainingResult {
  groupRemaining: ReturnType<typeof computeGroupRemaining>;
  memberBudget: string;
  memberSpent: string;
  conversationBudget: string;
  totalSpent: string;
}

/**
 * Looks up the member's budget from the conversation budgets result and computes
 * group remaining values. Shared by buildBillingInput and buildGuestBillingInput.
 */
function resolveGroupRemaining(
  budgets: Awaited<ReturnType<typeof getConversationBudgets>>,
  memberId: string,
  ownerBalanceCents: number,
  reserved: Awaited<ReturnType<typeof getGroupReservedTotals>>
): ResolveGroupRemainingResult {
  const currentMemberBudget = budgets.memberBudgets.find((mb) => mb.memberId === memberId);

  const memberBudget = currentMemberBudget?.budget ?? '0.00';
  const memberSpent = currentMemberBudget?.spent ?? '0';

  const groupRemaining = computeGroupRemaining({
    conversationBudget: budgets.conversationBudget,
    conversationSpent: budgets.totalSpent,
    memberBudget,
    memberSpent,
    ownerBalanceCents,
    reserved,
  });

  return {
    groupRemaining,
    memberBudget,
    memberSpent,
    conversationBudget: budgets.conversationBudget,
    totalSpent: budgets.totalSpent,
  };
}

export async function buildBillingInput(
  db: Database,
  redis: Redis,
  params: BuildBillingInputParams
): Promise<BuildBillingResult> {
  const { userId, models, memberContext, conversationId, apiKey } = params;
  // 1. User tier info + Redis reservations + model premium check (in parallel)
  const [userTierInfo, reservedCents, openrouterModels] = await Promise.all([
    getUserTierInfo(db, userId),
    getReservedTotal(redis, userId),
    fetchModels(apiKey),
  ]);

  const { premiumIds } = processModels(openrouterModels);
  const isPremiumModel = models.some((m) => premiumIds.includes(m));

  const adjustedBalanceCents = userTierInfo.balanceCents - reservedCents;
  const adjustedFreeAllowanceCents = userTierInfo.freeAllowanceCents - reservedCents;

  const input: ResolveBillingInput = {
    tier: userTierInfo.tier,
    balanceCents: adjustedBalanceCents,
    freeAllowanceCents: adjustedFreeAllowanceCents,
    isPremiumModel,
    estimatedMinimumCostCents: 0, // Set by caller after tier-aware computation
  };

  // 2. Group path: if user is a member (not owner), gather group billing data
  if (memberContext !== undefined && conversationId !== undefined) {
    const [ownerTierInfo, reserved, budgets] = await Promise.all([
      getUserTierInfo(db, memberContext.ownerId),
      getGroupReservedTotals(redis, conversationId, memberContext.memberId, memberContext.ownerId),
      getConversationBudgets(db, conversationId),
    ]);

    const resolved = resolveGroupRemaining(
      budgets,
      memberContext.memberId,
      ownerTierInfo.balanceCents,
      reserved
    );

    input.group = {
      effectiveCents: effectiveBudgetCents(resolved.groupRemaining),
      ownerTier: ownerTierInfo.tier,
      ownerBalanceCents: ownerTierInfo.balanceCents - reserved.payerTotal,
    };

    return {
      input,
      rawUserBalanceCents: userTierInfo.balanceCents,
      rawFreeAllowanceCents: userTierInfo.freeAllowanceCents,
      groupBudgetContext: {
        conversationBudget: resolved.conversationBudget,
        conversationSpent: resolved.totalSpent,
        memberBudget: resolved.memberBudget,
        memberSpent: resolved.memberSpent,
        ownerBalanceCents: ownerTierInfo.balanceCents,
      },
    };
  }

  return {
    input,
    rawUserBalanceCents: userTierInfo.balanceCents,
    rawFreeAllowanceCents: userTierInfo.freeAllowanceCents,
  };
}

/**
 * Gather billing data for a link guest.
 *
 * Guests have no personal wallet, so this skips personal tier/reservation lookups.
 * Only queries: owner tier info, group budgets, group Redis reservations, and
 * model premium check. Returns the same `BuildBillingResult` shape.
 */
export async function buildGuestBillingInput(
  db: Database,
  redis: Redis,
  params: BuildGuestBillingInputParams
): Promise<BuildBillingResult> {
  const { ownerId, memberId, models, conversationId, apiKey } = params;

  const [ownerTierInfo, reserved, budgets, openrouterModels] = await Promise.all([
    getUserTierInfo(db, ownerId),
    getGroupReservedTotals(redis, conversationId, memberId, ownerId),
    getConversationBudgets(db, conversationId),
    fetchModels(apiKey),
  ]);

  const { premiumIds } = processModels(openrouterModels);
  const isPremiumModel = models.some((m) => premiumIds.includes(m));

  const resolved = resolveGroupRemaining(budgets, memberId, ownerTierInfo.balanceCents, reserved);

  const input: ResolveBillingInput = {
    tier: 'guest',
    balanceCents: 0,
    freeAllowanceCents: 0,
    isPremiumModel,
    estimatedMinimumCostCents: 0,
    group: {
      effectiveCents: effectiveBudgetCents(resolved.groupRemaining),
      ownerTier: ownerTierInfo.tier,
      ownerBalanceCents: ownerTierInfo.balanceCents - reserved.payerTotal,
    },
  };

  return {
    input,
    rawUserBalanceCents: 0,
    rawFreeAllowanceCents: 0,
    groupBudgetContext: {
      conversationBudget: resolved.conversationBudget,
      conversationSpent: resolved.totalSpent,
      memberBudget: resolved.memberBudget,
      memberSpent: resolved.memberSpent,
      ownerBalanceCents: ownerTierInfo.balanceCents,
    },
  };
}
