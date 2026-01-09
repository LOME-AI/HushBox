import { eq } from 'drizzle-orm';
import { users, type Database } from '@lome-chat/db';
import { getUserTier, FREE_ALLOWANCE_CENTS, type UserTierInfo } from '@lome-chat/shared';

export interface BalanceCheckResult {
  hasBalance: boolean;
  currentBalance: string;
}

/**
 * Check if user has positive balance or free allowance.
 * Returns balance for display even if insufficient.
 *
 * With dual-balance system:
 * - Primary balance > 0: Can use any model
 * - Primary balance = 0 but free allowance > 0: Can use basic models
 * - Both zero: No access
 */
export async function checkUserBalance(db: Database, userId: string): Promise<BalanceCheckResult> {
  const [user] = await db
    .select({
      balance: users.balance,
      freeAllowanceCents: users.freeAllowanceCents,
      freeAllowanceResetAt: users.freeAllowanceResetAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  const balance = user?.balance ?? '0';
  const balanceValue = parseFloat(balance);

  // Check if free allowance needs reset
  let freeAllowanceCents = user?.freeAllowanceCents ?? 0;
  if (user && needsFreeAllowanceReset(user.freeAllowanceResetAt)) {
    freeAllowanceCents = FREE_ALLOWANCE_CENTS;
  }

  // User has balance if: primary balance > 0 OR free allowance > 0
  const hasBalance = balanceValue > 0 || freeAllowanceCents > 0;

  return { hasBalance, currentBalance: balance };
}

/**
 * Get the start of the current UTC day.
 */
function getUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Check if free allowance needs to be reset (lazy reset at UTC midnight).
 */
function needsFreeAllowanceReset(resetAt: Date | null): boolean {
  if (resetAt === null) {
    // First-time user, or never reset - trigger reset to set timestamp
    return true;
  }
  const midnight = getUtcMidnight();
  return resetAt < midnight;
}

/**
 * Get user tier info with lazy reset of free allowance.
 * Returns full tier information for authorization decisions.
 *
 * @param db - Database connection
 * @param userId - User ID, or null for guest
 * @returns Tier info with balances
 */
export async function getUserTierInfo(db: Database, userId: string | null): Promise<UserTierInfo> {
  // Guest users
  if (userId === null) {
    return getUserTier(null);
  }

  // Fetch user with balance and free allowance
  const [user] = await db
    .select({
      balance: users.balance,
      freeAllowanceCents: users.freeAllowanceCents,
      freeAllowanceResetAt: users.freeAllowanceResetAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    // User not found, treat as guest
    return getUserTier(null);
  }

  // Check if free allowance needs reset
  let freeAllowanceCents = user.freeAllowanceCents;
  if (needsFreeAllowanceReset(user.freeAllowanceResetAt)) {
    // Reset free allowance
    freeAllowanceCents = FREE_ALLOWANCE_CENTS;

    // Update in database (fire-and-forget, don't block)
    void db
      .update(users)
      .set({
        freeAllowanceCents: FREE_ALLOWANCE_CENTS,
        freeAllowanceResetAt: getUtcMidnight(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .catch((err: unknown) => {
        console.error('Failed to reset free allowance:', err);
      });
  }

  // Convert balance from dollars to cents
  const balanceCents = Math.round(parseFloat(user.balance) * 100);

  return getUserTier({
    balanceCents,
    freeAllowanceCents,
  });
}
