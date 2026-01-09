/**
 * User tier system for LOME-CHAT.
 *
 * Tiers:
 * - guest: Unauthenticated user (message limit, basic models only)
 * - free: Authenticated user with zero balance (daily allowance, basic models only)
 * - paid: Authenticated user with positive balance (all models)
 *
 * See docs/BILLING.md for full documentation.
 */

// ============================================================
// Constants (re-exported from @lome-chat/db)
// ============================================================

export {
  FREE_ALLOWANCE_CENTS,
  GUEST_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
  WELCOME_CREDIT_BALANCE,
} from '@lome-chat/db/constants';

// ============================================================
// Types
// ============================================================

export type UserTier = 'guest' | 'free' | 'paid';

export interface UserTierInfo {
  tier: UserTier;
  canAccessPremium: boolean;
  balanceCents: number;
  freeAllowanceCents: number;
}

export interface UserBalanceState {
  balanceCents: number;
  freeAllowanceCents: number;
}

export type DeductionSource = 'balance' | 'freeAllowance' | 'insufficient';

// ============================================================
// Functions
// ============================================================

/**
 * Derive user tier from balance state.
 * Single source of truth for tier determination.
 *
 * @param user - User's balance state, or null for guest
 * @returns Full tier info including access permissions
 */
export function getUserTier(user: UserBalanceState | null): UserTierInfo {
  if (user === null) {
    return {
      tier: 'guest',
      canAccessPremium: false,
      balanceCents: 0,
      freeAllowanceCents: 0,
    };
  }

  const tier: UserTier = user.balanceCents > 0 ? 'paid' : 'free';

  return {
    tier,
    canAccessPremium: tier === 'paid',
    balanceCents: user.balanceCents,
    freeAllowanceCents: user.freeAllowanceCents,
  };
}

/**
 * Check if a user can use a specific model.
 *
 * @param tierInfo - User's tier info
 * @param isPremiumModel - Whether the model is premium
 * @returns True if the user can use the model
 */
export function canUseModel(tierInfo: UserTierInfo, isPremiumModel: boolean): boolean {
  if (!isPremiumModel) {
    return true; // Anyone can use basic models
  }
  return tierInfo.canAccessPremium;
}

/**
 * Determine which balance source to deduct from.
 *
 * Order:
 * 1. Primary balance first
 * 2. Free allowance (only for basic models, when balance insufficient)
 *
 * @param tierInfo - User's tier info
 * @param costCents - Cost in cents
 * @param isPremiumModel - Whether the model is premium
 * @returns Which source to deduct from, or 'insufficient' if neither has enough
 */
export function getDeductionSource(
  tierInfo: UserTierInfo,
  costCents: number,
  isPremiumModel: boolean
): DeductionSource {
  // Primary balance first
  if (tierInfo.balanceCents >= costCents) {
    return 'balance';
  }

  // Free allowance only for basic models
  if (!isPremiumModel && tierInfo.freeAllowanceCents >= costCents) {
    return 'freeAllowance';
  }

  return 'insufficient';
}
