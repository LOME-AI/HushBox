import { describe, it, expect } from 'vitest';
import {
  resolveBilling,
  type ResolveBillingInput,
  type ResolveBillingResult,
} from './resolve-billing.js';
import { MAX_ALLOWED_NEGATIVE_BALANCE_CENTS, MAX_TRIAL_MESSAGE_COST_CENTS } from './constants.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a personal (non-group) input with sensible defaults */
function personalInput(overrides: Partial<ResolveBillingInput> = {}): ResolveBillingInput {
  return {
    tier: 'paid',
    balanceCents: 1000,
    freeAllowanceCents: 0,
    isPremiumModel: false,
    estimatedMinimumCostCents: 10,
    ...overrides,
  };
}

/** Build a group input with sensible defaults */
function groupInput(
  groupOverrides: Partial<NonNullable<ResolveBillingInput['group']>> = {},
  inputOverrides: Partial<ResolveBillingInput> = {}
): ResolveBillingInput {
  return {
    tier: 'paid',
    balanceCents: 1000,
    freeAllowanceCents: 0,
    isPremiumModel: false,
    estimatedMinimumCostCents: 10,
    ...inputOverrides,
    group: {
      effectiveCents: 500,
      ownerTier: 'paid',
      ownerBalanceCents: 5000,
      ...groupOverrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveBilling', () => {
  // --------------------------------------------------------------------------
  // Personal: Happy Paths
  // --------------------------------------------------------------------------

  describe('personal: happy paths', () => {
    it('returns personal_balance for paid tier with sufficient balance and non-premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 1000,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('returns personal_balance for paid tier with sufficient balance and premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 1000,
          isPremiumModel: true,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('returns free_allowance for free tier with available allowance and non-premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 100,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
    });

    it('returns guest_fixed for trial user within fixed cost cap', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'trial',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: MAX_TRIAL_MESSAGE_COST_CENTS,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'guest_fixed' });
    });

    it('returns guest_fixed for guest user within fixed cost cap', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'guest',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: MAX_TRIAL_MESSAGE_COST_CENTS,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'guest_fixed' });
    });
  });

  // --------------------------------------------------------------------------
  // Personal: Denials
  // --------------------------------------------------------------------------

  describe('personal: denials', () => {
    it('denies free tier user attempting premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 100,
          isPremiumModel: true,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'premium_requires_balance',
      });
    });

    it('denies trial user attempting premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'trial',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: true,
          estimatedMinimumCostCents: 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'premium_requires_balance',
      });
    });

    it('denies guest user attempting premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'guest',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: true,
          estimatedMinimumCostCents: 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'premium_requires_balance',
      });
    });

    it('denies paid tier with insufficient balance for non-premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 10,
          isPremiumModel: false,
          estimatedMinimumCostCents: 200,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });
    });

    it('denies paid tier with insufficient balance for premium model', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 10,
          isPremiumModel: true,
          estimatedMinimumCostCents: 200,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });
    });

    it('denies free tier with depleted allowance', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_free_allowance',
      });
    });

    it('denies trial user exceeding fixed cost cap', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'trial',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: MAX_TRIAL_MESSAGE_COST_CENTS + 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'guest_limit_exceeded',
      });
    });

    it('denies guest user exceeding fixed cost cap', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'guest',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: MAX_TRIAL_MESSAGE_COST_CENTS + 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'guest_limit_exceeded',
      });
    });
  });

  // --------------------------------------------------------------------------
  // Group: Paths
  // --------------------------------------------------------------------------

  describe('group paths', () => {
    it('returns owner_balance when group has budget and owner can afford non-premium', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 500, ownerTier: 'paid', ownerBalanceCents: 5000 },
          { isPremiumModel: false }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
    });

    it('returns owner_balance when group has budget and owner can afford premium', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 500, ownerTier: 'paid', ownerBalanceCents: 5000 },
          { isPremiumModel: true }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
    });

    it('falls through to personal when owner cannot use premium model — user is paid', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 500, ownerTier: 'free', ownerBalanceCents: 0 },
          { tier: 'paid', balanceCents: 1000, isPremiumModel: true, estimatedMinimumCostCents: 10 }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('falls through to personal when owner cannot use premium — user is free → denied', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 500, ownerTier: 'free', ownerBalanceCents: 0 },
          {
            tier: 'free',
            balanceCents: 0,
            freeAllowanceCents: 100,
            isPremiumModel: true,
            estimatedMinimumCostCents: 10,
          }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'premium_requires_balance',
      });
    });

    it('falls through to personal when group budget is zero — user is paid', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 0, ownerTier: 'paid', ownerBalanceCents: 5000 },
          { tier: 'paid', balanceCents: 1000, estimatedMinimumCostCents: 10 }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('falls through to personal when group budget is negative — user is free with allowance', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: -100, ownerTier: 'paid', ownerBalanceCents: 5000 },
          {
            tier: 'free',
            balanceCents: 0,
            freeAllowanceCents: 100,
            isPremiumModel: false,
            estimatedMinimumCostCents: 10,
          }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
    });

    it('does NOT deny when group budget is exhausted — falls through to personal', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: 0, ownerTier: 'paid', ownerBalanceCents: 5000 },
          { tier: 'paid', balanceCents: 1000, isPremiumModel: false, estimatedMinimumCostCents: 10 }
        )
      );

      // Must NOT be denied — group exhaustion falls through to personal
      expect(result.fundingSource).not.toBe('denied');
      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('paid tier with zero balance: cushion covers cheap messages', () => {
      // Effective = 0 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 50 >= 1
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 0,
          estimatedMinimumCostCents: 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('paid tier with zero balance: cushion insufficient for expensive messages', () => {
      // Effective = 0 + 50 = 50 < 100
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 0,
          estimatedMinimumCostCents: 100,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });
    });

    it('free tier with zero allowance and non-zero cost', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 1,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_free_allowance',
      });
    });

    it('zero estimated cost: paid tier always approved', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 0,
          estimatedMinimumCostCents: 0,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('zero estimated cost: free tier always approved', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 0,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
    });

    it('zero estimated cost: trial always approved', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'trial',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: 0,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'guest_fixed' });
    });

    it('paid tier at exact boundary: balance + cushion equals cost', () => {
      // Effective = 50 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 100 >= 100
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 100 - MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
          estimatedMinimumCostCents: 100,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('paid tier 1 cent below boundary: denied', () => {
      // Effective = 49 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 99 < 100
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: 100 - MAX_ALLOWED_NEGATIVE_BALANCE_CENTS - 1,
          estimatedMinimumCostCents: 100,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });
    });

    it('free tier at exact boundary: allowance equals cost', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: 10,
          isPremiumModel: false,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
    });

    it('free tier allows when allowance matches cost within float tolerance', () => {
      // 0.98765432 cents loses precision in numeric(20,8) round-trip:
      // (0.98765432 / 100).toFixed(8) = "0.00987654" → parseFloat * 100 = 0.9876539999... < 0.98765432
      const cost = 0.987_654_32;
      // Simulate numeric(20,8) round-trip precision loss: dollars → toFixed(8) → parseFloat → *100
      const roundTripped = Number.parseFloat((cost / 100).toFixed(8)) * 100;
      const result = resolveBilling(
        personalInput({
          tier: 'free',
          balanceCents: 0,
          freeAllowanceCents: roundTripped,
          isPremiumModel: false,
          estimatedMinimumCostCents: cost,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
    });

    it('trial at exact boundary: cost equals MAX_TRIAL_MESSAGE_COST_CENTS', () => {
      const result = resolveBilling(
        personalInput({
          tier: 'trial',
          balanceCents: 0,
          freeAllowanceCents: 0,
          isPremiumModel: false,
          estimatedMinimumCostCents: MAX_TRIAL_MESSAGE_COST_CENTS,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'guest_fixed' });
    });

    it('group with negative effectiveCents falls through to personal', () => {
      const result = resolveBilling(
        groupInput(
          { effectiveCents: -50 },
          { tier: 'paid', balanceCents: 1000, estimatedMinimumCostCents: 10 }
        )
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });

    it('paid tier with negative balance: cushion may still cover', () => {
      // balanceCents = -20, effective = -20 + 50 = 30 >= 10
      const result = resolveBilling(
        personalInput({
          tier: 'paid',
          balanceCents: -20,
          estimatedMinimumCostCents: 10,
        })
      );

      expect(result).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
    });
  });
});
