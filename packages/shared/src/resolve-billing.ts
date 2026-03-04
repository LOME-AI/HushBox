/**
 * Centralized billing resolution for HushBox.
 *
 * `resolveBilling()` is the single source of truth for billing decisions.
 * It determines WHO pays for a message (FundingSource) or WHY it's denied (DenialReason).
 * Both frontend and backend call this same function.
 *
 * ## Frontend vs Backend Input Sources — Divergence Map
 *
 * Both sides call the same function. The divergence comes from WHERE each side gets the input values.
 *
 * | Input field | Frontend source | Backend source | Divergence risk |
 * |---|---|---|---|
 * | `tier` | `useBalance()` API → `getUserTier()` | `getUserTierInfo(db, userId)` (wallets table) | **Low** — both derive from same wallets data |
 * | `balanceCents` | `useBalance()` API response | wallets query **minus Redis reservations** | **HIGH** — frontend sees gross balance, backend subtracts in-flight reservations |
 * | `freeAllowanceCents` | `useBalance()` API response | wallets query with **lazy renewal** | **Medium** — rare, renewal happens at most once per day |
 * | `isPremiumModel` | `/models` API → `premiumIds.includes()` | `fetchModels()` → `processModels()` → `premiumIds` | **Low** — both read from same OpenRouter API |
 * | `estimatedMinimumCostCents` | `calculateBudget()` with local char count | `calculateBudget()` with real message data | **Low** — both call same function with same pricing |
 * | `group.effectiveCents` | `GET /budgets` API response | `computeGroupRemaining()` using DB + Redis reservations | **HIGH** — same Redis reservation gap |
 * | `group.ownerTier` | budgets API response | `getUserTierInfo(db, ownerId)` | **N/A** — new field |
 * | `group.ownerBalanceCents` | budgets API response | wallets query minus Redis reservations | **HIGH** — same Redis reservation gap |
 *
 * The **primary divergence source is Redis speculative balance reservations**. The frontend is always
 * optimistic (sees full balance), while the backend is pessimistic (subtracts in-flight reservations).
 * This is exactly the scenario where the `billing_mismatch` inline error fires — the user retries
 * after concurrent streams complete and reservations release.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS } from './constants.js';
import { getCushionCents } from './budget.js';
import { canUseModel, type UserTier, type UserTierInfo } from './tiers.js';

/**
 * Floating-point tolerance for free tier balance comparison.
 * The wallet balance round-trip (numeric(20,8) → parseFloat → *100) can lose
 * sub-cent precision vs the independently computed estimatedMinimumCostCents.
 * 1e-6 cents = $0.00000001 — negligible for real money, absorbs float errors.
 */
const FREE_TIER_FLOAT_TOLERANCE_CENTS = 1e-6;

// ============================================================================
// Types
// ============================================================================

export type FundingSource = 'owner_balance' | 'personal_balance' | 'free_allowance' | 'guest_fixed';

export type DenialReason =
  | 'premium_requires_balance'
  | 'insufficient_balance'
  | 'insufficient_free_allowance'
  | 'guest_limit_exceeded';

export type ResolveBillingResult =
  | { fundingSource: FundingSource }
  | { fundingSource: 'denied'; reason: DenialReason };

export interface ResolveBillingInput {
  tier: UserTier;
  balanceCents: number;
  freeAllowanceCents: number;
  isPremiumModel: boolean;
  estimatedMinimumCostCents: number;
  group?: {
    effectiveCents: number;
    ownerTier: UserTier;
    ownerBalanceCents: number;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Attempt group billing: owner pays if group has budget and owner can use the model. */
function resolveGroupBilling(
  group: ResolveBillingInput['group'],
  isPremiumModel: boolean
): ResolveBillingResult | undefined {
  if (group === undefined || group.effectiveCents <= 0) return undefined;
  const ownerTierInfo: UserTierInfo = {
    tier: group.ownerTier,
    canAccessPremium: group.ownerTier === 'paid',
    balanceCents: group.ownerBalanceCents,
    freeAllowanceCents: 0,
  };
  if (canUseModel(ownerTierInfo, isPremiumModel)) {
    return { fundingSource: 'owner_balance' };
  }
  return undefined;
}

// ============================================================================
// Core Function
// ============================================================================

/**
 * Resolve billing for a message: determines WHO pays or WHY it's denied.
 *
 * Decision order:
 * 1. Group billing: if group context with budget > 0 and owner can use model → owner_balance
 * 2. Group fallthrough: if group budget ≤ 0 or owner can't use model → personal billing
 * 3. Premium gating: canUseModel() → denied: premium_requires_balance
 * 4. Paid tier with sufficient balance → personal_balance
 * 5. Free tier with allowance → free_allowance
 * 6. Trial/guest within fixed cost → guest_fixed
 * 7. Otherwise → denied with tier-specific reason
 */
export function resolveBilling(input: ResolveBillingInput): ResolveBillingResult {
  const {
    tier,
    balanceCents,
    freeAllowanceCents,
    isPremiumModel,
    estimatedMinimumCostCents,
    group,
  } = input;

  // 1. Group billing: if group context with budget > 0 and owner can use model
  const groupResult = resolveGroupBilling(group, isPremiumModel);
  if (groupResult !== undefined) return groupResult;

  // 2. Premium gating (personal path)
  const userTierInfo: UserTierInfo = {
    tier,
    canAccessPremium: tier === 'paid',
    balanceCents,
    freeAllowanceCents,
  };
  if (!canUseModel(userTierInfo, isPremiumModel)) {
    return { fundingSource: 'denied', reason: 'premium_requires_balance' };
  }

  // 3. Paid tier with sufficient balance
  if (tier === 'paid') {
    const effectiveBalanceCents = balanceCents + getCushionCents(tier);
    if (effectiveBalanceCents >= estimatedMinimumCostCents) {
      return { fundingSource: 'personal_balance' };
    }
    return { fundingSource: 'denied', reason: 'insufficient_balance' };
  }

  // 4. Free tier with allowance (non-premium only — premium already gated above)
  if (tier === 'free') {
    if (freeAllowanceCents + FREE_TIER_FLOAT_TOLERANCE_CENTS >= estimatedMinimumCostCents) {
      return { fundingSource: 'free_allowance' };
    }
    return { fundingSource: 'denied', reason: 'insufficient_free_allowance' };
  }

  // 5. Trial/guest within fixed cost cap
  if (estimatedMinimumCostCents <= MAX_TRIAL_MESSAGE_COST_CENTS) {
    return { fundingSource: 'guest_fixed' };
  }
  return { fundingSource: 'denied', reason: 'guest_limit_exceeded' };
}
