/**
 * User tier system for HushBox.
 *
 * Tiers:
 * - trial: Unauthenticated user on main app (message limit, basic models only)
 * - guest: Accessing via shared link (delegated budget from owner)
 * - free: Authenticated user with zero balance (daily allowance, basic models only)
 * - paid: Authenticated user with positive balance (all models)
 *
 * See docs/BILLING.md for full documentation.
 */

// ============================================================
// Constants (re-exported from @hushbox/db)
// ============================================================

export {
  FREE_ALLOWANCE_DOLLARS,
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
  WELCOME_CREDIT_BALANCE,
} from '@hushbox/db/constants';

// ============================================================
// Types
// ============================================================

export type UserTier = 'trial' | 'guest' | 'free' | 'paid';

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

// ============================================================
// Functions
// ============================================================

/**
 * Derive user tier from balance state.
 * Single source of truth for tier determination.
 *
 * @param user - User's balance state, or null for unauthenticated
 * @param options - Optional flags (isLinkGuest distinguishes trial from guest)
 * @returns Full tier info including access permissions
 */
export function getUserTier(
  user: UserBalanceState | null,
  options?: { isLinkGuest?: boolean }
): UserTierInfo {
  if (user === null) {
    return {
      tier: options?.isLinkGuest ? 'guest' : 'trial',
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
