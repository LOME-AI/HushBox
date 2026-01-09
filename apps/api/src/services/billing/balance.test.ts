import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users, type Database } from '@lome-chat/db';
import { userFactory } from '@lome-chat/db/factories';
import { FREE_ALLOWANCE_CENTS } from '@lome-chat/shared';
import { checkUserBalance, getUserTierInfo } from './balance.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('checkUserBalance', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    // Clean up created users
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  function getTodayMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  async function createTestUser(
    balance: string,
    freeAllowanceCents: number = FREE_ALLOWANCE_CENTS,
    freeAllowanceResetAt: Date | null = null
  ) {
    const userData = userFactory.build({ balance, freeAllowanceCents, freeAllowanceResetAt });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  it('returns true for positive balance', async () => {
    const user = await createTestUser('10.00000000');

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('10.00000000');
  });

  it('returns true for zero balance with free allowance', async () => {
    // Set resetAt to today to prevent reset
    const user = await createTestUser('0.00000000', 5, getTodayMidnight());

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(true); // Can still use basic models
    expect(result.currentBalance).toBe('0.00000000');
  });

  it('returns false for zero balance with no free allowance', async () => {
    // Set resetAt to today so the 0 allowance isn't reset
    const user = await createTestUser('0.00000000', 0, getTodayMidnight());

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('0.00000000');
  });

  it('returns false for negative balance with no free allowance', async () => {
    // Set resetAt to today so the 0 allowance isn't reset
    const user = await createTestUser('-5.00000000', 0, getTodayMidnight());

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('-5.00000000');
  });

  it('returns false and zero balance for non-existent user', async () => {
    const result = await checkUserBalance(db, 'non-existent-user-id');

    expect(result.hasBalance).toBe(false);
    expect(result.currentBalance).toBe('0');
  });

  it('handles very small positive balance', async () => {
    const user = await createTestUser('0.00000001');

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('0.00000001');
  });

  it('handles large balance', async () => {
    const user = await createTestUser('999999.99999999');

    const result = await checkUserBalance(db, user.id);

    expect(result.hasBalance).toBe(true);
    expect(result.currentBalance).toBe('999999.99999999');
  });
});

describe('getUserTierInfo', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  async function createTestUser(overrides: {
    balance?: string;
    freeAllowanceCents?: number;
    freeAllowanceResetAt?: Date | null;
  }) {
    const userData = userFactory.build({
      balance: overrides.balance ?? '0.00000000',
      freeAllowanceCents: overrides.freeAllowanceCents ?? FREE_ALLOWANCE_CENTS,
      freeAllowanceResetAt: overrides.freeAllowanceResetAt ?? null,
    });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  it('returns paid tier for user with positive balance', async () => {
    const user = await createTestUser({ balance: '10.00000000' });

    const result = await getUserTierInfo(db, user.id);

    expect(result.tier).toBe('paid');
    expect(result.canAccessPremium).toBe(true);
    expect(result.balanceCents).toBeGreaterThan(0);
  });

  it('returns free tier for user with zero balance', async () => {
    const user = await createTestUser({ balance: '0.00000000' });

    const result = await getUserTierInfo(db, user.id);

    expect(result.tier).toBe('free');
    expect(result.canAccessPremium).toBe(false);
    expect(result.balanceCents).toBe(0);
  });

  it('includes free allowance in tier info', async () => {
    const user = await createTestUser({
      balance: '0.00000000',
      freeAllowanceCents: 5,
    });

    const result = await getUserTierInfo(db, user.id);

    expect(result.freeAllowanceCents).toBe(5);
  });

  it('returns guest tier for null user', async () => {
    const result = await getUserTierInfo(db, null);

    expect(result.tier).toBe('guest');
    expect(result.canAccessPremium).toBe(false);
    expect(result.balanceCents).toBe(0);
    expect(result.freeAllowanceCents).toBe(0);
  });

  describe('lazy reset of free allowance', () => {
    it('resets free allowance when resetAt is before today UTC midnight', async () => {
      // User's last reset was yesterday
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(0, 0, 0, 0);

      const user = await createTestUser({
        balance: '0.00000000',
        freeAllowanceCents: 2, // partially used
        freeAllowanceResetAt: yesterday,
      });

      const result = await getUserTierInfo(db, user.id);

      // Should be reset to full allowance
      expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS);
    });

    it('does not reset if already reset today', async () => {
      // Reset at midnight today
      const todayMidnight = new Date();
      todayMidnight.setUTCHours(0, 0, 0, 0);

      const user = await createTestUser({
        balance: '0.00000000',
        freeAllowanceCents: 2, // partially used
        freeAllowanceResetAt: todayMidnight,
      });

      const result = await getUserTierInfo(db, user.id);

      // Should NOT be reset - still has partial allowance
      expect(result.freeAllowanceCents).toBe(2);
    });

    it('resets if resetAt is null (first time user)', async () => {
      const user = await createTestUser({
        balance: '0.00000000',
        freeAllowanceCents: 3, // partial
        freeAllowanceResetAt: null,
      });

      const result = await getUserTierInfo(db, user.id);

      // First-time users with null resetAt get reset to full allowance
      expect(result.freeAllowanceCents).toBe(FREE_ALLOWANCE_CENTS);
    });
  });
});
