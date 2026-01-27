import { describe, it, expect } from 'vitest';
import {
  getUserTier,
  canUseModel,
  getDeductionSource,
  FREE_ALLOWANCE_CENTS,
  FREE_ALLOWANCE_CENTS_VALUE,
  GUEST_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
  type UserTierInfo,
} from './tiers.js';

describe('tiers', () => {
  describe('constants', () => {
    it('exports FREE_ALLOWANCE_CENTS as a numeric string for database', () => {
      expect(typeof FREE_ALLOWANCE_CENTS).toBe('string');
      expect(Number.parseFloat(FREE_ALLOWANCE_CENTS)).toBeGreaterThan(0);
    });

    it('exports FREE_ALLOWANCE_CENTS_VALUE as a positive integer for calculations', () => {
      expect(FREE_ALLOWANCE_CENTS_VALUE).toBeGreaterThan(0);
      expect(Number.isInteger(FREE_ALLOWANCE_CENTS_VALUE)).toBe(true);
    });

    it('exports GUEST_MESSAGE_LIMIT as a positive integer', () => {
      expect(GUEST_MESSAGE_LIMIT).toBeGreaterThan(0);
      expect(Number.isInteger(GUEST_MESSAGE_LIMIT)).toBe(true);
    });

    it('exports WELCOME_CREDIT_CENTS as a positive integer', () => {
      expect(WELCOME_CREDIT_CENTS).toBeGreaterThan(0);
      expect(Number.isInteger(WELCOME_CREDIT_CENTS)).toBe(true);
    });
  });

  describe('getUserTier', () => {
    it('returns guest tier when user is null', () => {
      const result = getUserTier(null);

      expect(result).toEqual<UserTierInfo>({
        tier: 'guest',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      });
    });

    it('returns paid tier when user has positive balance', () => {
      const result = getUserTier({ balanceCents: 100, freeAllowanceCents: 5 });

      expect(result).toEqual<UserTierInfo>({
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 100,
        freeAllowanceCents: 5,
      });
    });

    it('returns free tier when user has zero balance', () => {
      const result = getUserTier({ balanceCents: 0, freeAllowanceCents: 5 });

      expect(result).toEqual<UserTierInfo>({
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 5,
      });
    });

    it('returns free tier when user has negative balance', () => {
      const result = getUserTier({ balanceCents: -10, freeAllowanceCents: 5 });

      expect(result).toEqual<UserTierInfo>({
        tier: 'free',
        canAccessPremium: false,
        balanceCents: -10,
        freeAllowanceCents: 5,
      });
    });
  });

  describe('canUseModel', () => {
    it('allows any tier to use basic models', () => {
      const guestTier: UserTierInfo = {
        tier: 'guest',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      };
      const freeTier: UserTierInfo = {
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 5,
      };
      const paidTier: UserTierInfo = {
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 100,
        freeAllowanceCents: 5,
      };

      expect(canUseModel(guestTier, false)).toBe(true);
      expect(canUseModel(freeTier, false)).toBe(true);
      expect(canUseModel(paidTier, false)).toBe(true);
    });

    it('only allows paid tier to use premium models', () => {
      const guestTier: UserTierInfo = {
        tier: 'guest',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      };
      const freeTier: UserTierInfo = {
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 5,
      };
      const paidTier: UserTierInfo = {
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 100,
        freeAllowanceCents: 5,
      };

      expect(canUseModel(guestTier, true)).toBe(false);
      expect(canUseModel(freeTier, true)).toBe(false);
      expect(canUseModel(paidTier, true)).toBe(true);
    });
  });

  describe('getDeductionSource', () => {
    it('returns balance when primary balance is sufficient', () => {
      const tierInfo: UserTierInfo = {
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 100,
        freeAllowanceCents: 5,
      };

      expect(getDeductionSource(tierInfo, 50, false)).toBe('balance');
      expect(getDeductionSource(tierInfo, 50, true)).toBe('balance');
    });

    it('returns freeAllowance for basic model when balance is insufficient', () => {
      const tierInfo: UserTierInfo = {
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 5,
      };

      expect(getDeductionSource(tierInfo, 3, false)).toBe('freeAllowance');
    });

    it('returns insufficient for premium model when balance is zero', () => {
      const tierInfo: UserTierInfo = {
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 5,
      };

      expect(getDeductionSource(tierInfo, 3, true)).toBe('insufficient');
    });

    it('returns insufficient when both balance and free allowance are insufficient', () => {
      const tierInfo: UserTierInfo = {
        tier: 'free',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 2,
      };

      expect(getDeductionSource(tierInfo, 5, false)).toBe('insufficient');
    });

    it('prefers balance over freeAllowance when both are sufficient', () => {
      const tierInfo: UserTierInfo = {
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 10,
        freeAllowanceCents: 5,
      };

      expect(getDeductionSource(tierInfo, 5, false)).toBe('balance');
    });
  });
});
