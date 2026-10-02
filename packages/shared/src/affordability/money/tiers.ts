/**
 * User tier system for HushBox.
 *
 * Tiers:
 * - trial: Unauthenticated user on main app (message limit, basic models only)
 * - guest: Accessing via shared link (delegated budget from owner)
 * - free: Authenticated user with zero balance (daily allowance, basic models only)
 * - paid: Authenticated user with positive balance (all models)
 */

/** Daily free allowance in cents ($0.05 = 5 cents) */
export const FREE_ALLOWANCE_CENTS_VALUE = 5;

/** Maximum messages per day for trial users */
export const TRIAL_MESSAGE_LIMIT = 5;

/** Welcome credit for new users in cents ($0.20 = 20 cents) */
export const WELCOME_CREDIT_CENTS = 20;

export type UserTier = 'trial' | 'guest' | 'free' | 'paid';

/**
 * The tier vocabulary as an exhaustive record: `satisfies Record<UserTier,
 * UserTier>` demands one entry per tier and rejects an entry that is not one, so
 * neither side can move alone.
 */
const TIER_VALUES = {
  trial: 'trial',
  guest: 'guest',
  free: 'free',
  paid: 'paid',
} as const satisfies Record<UserTier, UserTier>;

/**
 * Every tier, once. Code that must cover all of them imports this rather than
 * repeating the literal, so a tier added to {@link UserTier} cannot silently
 * narrow an invariant sweep to a subset — it fails to compile above instead.
 */
export const USER_TIERS: readonly UserTier[] = Object.values(TIER_VALUES);

export interface UserTierInfo {
  tier: UserTier;
  canAccessPremium: boolean;
  /** RAW served purchased-wallet balance in nano-USD (negative-capable). */
  purchasedBalanceNanoUsd: bigint;
  /** Served daily free-allowance remaining in nano-USD. */
  freeAllowanceNanoUsd: bigint;
}

export interface UserBalanceState {
  purchasedBalanceNanoUsd: bigint;
  freeAllowanceNanoUsd: bigint;
}

/**
 * Derive user tier from balance state.
 * Single source of truth for tier determination. Money is exact nano-USD
 * bigint — a single positive nano is already `paid` (no cents truncation).
 *
 * @param user - User's balance state, or null for unauthenticated
 * @param options - Optional flags (isLinkGuest distinguishes trial from guest)
 * @returns Full tier info including access permissions
 */
/**
 * Whether a tier may call premium models. The rule lives here alone: the money
 * layer's per-row premium verdict and {@link getUserTier}'s `canAccessPremium`
 * are the same fact, so they read one function rather than repeating the
 * comparison in two places.
 */
export function tierCanAccessPremium(tier: UserTier): boolean {
  return tier === 'paid';
}

export function getUserTier(
  user: UserBalanceState | null,
  options?: { isLinkGuest?: boolean }
): UserTierInfo {
  if (user === null) {
    const tier: UserTier = options?.isLinkGuest ? 'guest' : 'trial';
    return {
      tier,
      canAccessPremium: tierCanAccessPremium(tier),
      purchasedBalanceNanoUsd: 0n,
      freeAllowanceNanoUsd: 0n,
    };
  }

  const tier: UserTier = user.purchasedBalanceNanoUsd > 0n ? 'paid' : 'free';

  return {
    tier,
    canAccessPremium: tierCanAccessPremium(tier),
    purchasedBalanceNanoUsd: user.purchasedBalanceNanoUsd,
    freeAllowanceNanoUsd: user.freeAllowanceNanoUsd,
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
