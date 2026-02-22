import { describe, it, expect } from 'vitest';
import {
  getUserTier,
  canUseModel,
  FREE_ALLOWANCE_DOLLARS,
  FREE_ALLOWANCE_CENTS_VALUE,
  TRIAL_MESSAGE_LIMIT,
  WELCOME_CREDIT_CENTS,
  type UserTierInfo,
} from './tiers.js';

describe('tiers', () => {
  describe('constants', () => {
    it('exports FREE_ALLOWANCE_DOLLARS as a dollar string for database', () => {
      expect(typeof FREE_ALLOWANCE_DOLLARS).toBe('string');
      expect(Number.parseFloat(FREE_ALLOWANCE_DOLLARS)).toBe(0.05);
    });

    it('exports FREE_ALLOWANCE_CENTS_VALUE as a positive integer for calculations', () => {
      expect(FREE_ALLOWANCE_CENTS_VALUE).toBeGreaterThan(0);
      expect(Number.isInteger(FREE_ALLOWANCE_CENTS_VALUE)).toBe(true);
    });

    it('exports TRIAL_MESSAGE_LIMIT as a positive integer', () => {
      expect(TRIAL_MESSAGE_LIMIT).toBeGreaterThan(0);
      expect(Number.isInteger(TRIAL_MESSAGE_LIMIT)).toBe(true);
    });

    it('exports WELCOME_CREDIT_CENTS as a positive integer', () => {
      expect(WELCOME_CREDIT_CENTS).toBeGreaterThan(0);
      expect(Number.isInteger(WELCOME_CREDIT_CENTS)).toBe(true);
    });
  });

  describe('getUserTier', () => {
    it('returns trial tier when user is null', () => {
      const result = getUserTier(null);

      expect(result).toEqual<UserTierInfo>({
        tier: 'trial',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      });
    });

    it('returns guest tier when user is null and isLinkGuest is true', () => {
      const result = getUserTier(null, { isLinkGuest: true });

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
      const trialTier: UserTierInfo = {
        tier: 'trial',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      };
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

      expect(canUseModel(trialTier, false)).toBe(true);
      expect(canUseModel(guestTier, false)).toBe(true);
      expect(canUseModel(freeTier, false)).toBe(true);
      expect(canUseModel(paidTier, false)).toBe(true);
    });

    it('only allows paid tier to use premium models', () => {
      const trialTier: UserTierInfo = {
        tier: 'trial',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      };
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

      expect(canUseModel(trialTier, true)).toBe(false);
      expect(canUseModel(guestTier, true)).toBe(false);
      expect(canUseModel(freeTier, true)).toBe(false);
      expect(canUseModel(paidTier, true)).toBe(true);
    });
  });
});
