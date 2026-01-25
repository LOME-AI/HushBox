import { describe, it, expect } from 'vitest';
import {
  calculateBudget,
  estimateTokensForTier,
  getEffectiveBalance,
  generateBudgetErrors,
  type BudgetCalculationInput,
  type BudgetCalculationResult,
} from './budget.js';
import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_GUEST_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  CAPACITY_RED_THRESHOLD,
  CAPACITY_YELLOW_THRESHOLD,
} from './constants.js';

describe('estimateTokensForTier', () => {
  describe('paid users', () => {
    it('uses standard 4 chars/token ratio', () => {
      expect(estimateTokensForTier('paid', 400)).toBe(100);
      expect(estimateTokensForTier('paid', 1000)).toBe(250);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('paid', 401)).toBe(101);
      expect(estimateTokensForTier('paid', 1)).toBe(1);
    });
  });

  describe('free users', () => {
    it('uses conservative 2 chars/token ratio', () => {
      expect(estimateTokensForTier('free', 400)).toBe(200);
      expect(estimateTokensForTier('free', 1000)).toBe(500);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('free', 401)).toBe(201);
      expect(estimateTokensForTier('free', 1)).toBe(1);
    });
  });

  describe('guest users', () => {
    it('uses conservative 2 chars/token ratio', () => {
      expect(estimateTokensForTier('guest', 400)).toBe(200);
      expect(estimateTokensForTier('guest', 1000)).toBe(500);
    });

    it('rounds up partial tokens', () => {
      expect(estimateTokensForTier('guest', 401)).toBe(201);
    });
  });

  describe('edge cases', () => {
    it('handles zero characters', () => {
      expect(estimateTokensForTier('paid', 0)).toBe(0);
      expect(estimateTokensForTier('free', 0)).toBe(0);
      expect(estimateTokensForTier('guest', 0)).toBe(0);
    });

    it('handles large character counts', () => {
      expect(estimateTokensForTier('paid', 1_000_000)).toBe(250_000);
      expect(estimateTokensForTier('free', 1_000_000)).toBe(500_000);
    });
  });
});

describe('getEffectiveBalance', () => {
  describe('guest users', () => {
    it('returns fixed max cost per message', () => {
      const result = getEffectiveBalance('guest', 0, 0);
      expect(result).toBe(MAX_GUEST_MESSAGE_COST_CENTS / 100);
    });

    it('ignores balance and allowance values', () => {
      const result = getEffectiveBalance('guest', 10_000, 500);
      expect(result).toBe(MAX_GUEST_MESSAGE_COST_CENTS / 100);
    });
  });

  describe('free users', () => {
    it('returns free allowance only (no cushion)', () => {
      const result = getEffectiveBalance('free', 0, 500);
      expect(result).toBe(5); // 500 cents = $5
    });

    it('ignores primary balance', () => {
      const result = getEffectiveBalance('free', 10_000, 500);
      expect(result).toBe(5); // Still just free allowance
    });

    it('handles zero allowance', () => {
      const result = getEffectiveBalance('free', 0, 0);
      expect(result).toBe(0);
    });
  });

  describe('paid users', () => {
    it('returns balance plus cushion', () => {
      const result = getEffectiveBalance('paid', 100, 0);
      expect(result).toBe((100 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) / 100);
    });

    it('includes the $0.50 cushion', () => {
      const result = getEffectiveBalance('paid', 0, 0);
      // Paid with $0 balance still gets $0.50 cushion
      // But wait - if balance is 0, tier should be 'free', not 'paid'
      // This function just calculates based on tier passed, doesn't validate
      expect(result).toBe(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS / 100);
    });

    it('ignores free allowance', () => {
      const result = getEffectiveBalance('paid', 100, 500);
      expect(result).toBe((100 + MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) / 100);
    });
  });
});

describe('calculateBudget', () => {
  const baseInput: BudgetCalculationInput = {
    tier: 'paid',
    balanceCents: 1000, // $10
    freeAllowanceCents: 0,
    promptCharacterCount: 4000, // ~1000 tokens at 4 chars/token
    modelInputPricePerToken: 0.000_03, // $0.03 per 1k input
    modelOutputPricePerToken: 0.000_06, // $0.06 per 1k output
    modelContextLength: 128_000,
  };

  describe('token estimation', () => {
    it('estimates tokens based on tier', () => {
      const paidResult = calculateBudget(baseInput);
      expect(paidResult.estimatedInputTokens).toBe(1000); // 4000/4

      const freeResult = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500,
      });
      expect(freeResult.estimatedInputTokens).toBe(2000); // 4000/2 (conservative)
    });
  });

  describe('cost estimation', () => {
    it('calculates estimated input cost', () => {
      const result = calculateBudget(baseInput);
      // 1000 tokens * $0.00003 = $0.03
      expect(result.estimatedInputCost).toBeCloseTo(0.03, 10);
    });

    it('calculates estimated minimum cost (input + min output)', () => {
      const result = calculateBudget(baseInput);
      // Input: 1000 * $0.00003 = $0.03
      // Min output: 1000 * $0.00006 = $0.06
      // Total: $0.09
      expect(result.estimatedMinimumCost).toBeCloseTo(0.09, 10);
    });
  });

  describe('effective balance', () => {
    it('calculates effective balance for paid users', () => {
      const result = calculateBudget(baseInput);
      // $10 + $0.50 cushion = $10.50
      expect(result.effectiveBalance).toBeCloseTo(10.5, 10);
    });

    it('calculates effective balance for free users', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 500, // $5
      });
      expect(result.effectiveBalance).toBe(5);
    });

    it('calculates effective balance for guests', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'guest',
        balanceCents: 0,
        freeAllowanceCents: 0,
      });
      expect(result.effectiveBalance).toBe(0.01);
    });
  });

  describe('affordability check', () => {
    it('returns canAfford=true when effective balance >= estimated minimum cost', () => {
      const result = calculateBudget(baseInput);
      expect(result.canAfford).toBe(true);
    });

    it('returns canAfford=false when effective balance < estimated minimum cost', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 1, // $0.01 - very low
        promptCharacterCount: 100_000, // Very long prompt
        modelInputPricePerToken: 0.0001, // Expensive model
        modelOutputPricePerToken: 0.0002,
      });
      expect(result.canAfford).toBe(false);
    });

    it('guests cannot afford expensive messages', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'guest',
        balanceCents: 0,
        freeAllowanceCents: 0,
        promptCharacterCount: 10_000, // Long prompt
        modelInputPricePerToken: 0.0001, // Expensive
        modelOutputPricePerToken: 0.0002,
      });
      expect(result.canAfford).toBe(false);
    });

    it('guests can afford cheap short messages', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'guest',
        balanceCents: 0,
        freeAllowanceCents: 0,
        promptCharacterCount: 100, // Very short
        modelInputPricePerToken: 0.000_000_1, // Very cheap
        modelOutputPricePerToken: 0.000_000_1,
      });
      expect(result.canAfford).toBe(true);
    });
  });

  describe('max output tokens', () => {
    it('calculates max output tokens based on remaining budget', () => {
      const result = calculateBudget(baseInput);
      // Effective balance: $10.50
      // Input cost: $0.03
      // Remaining: $10.47
      // Max output tokens: $10.47 / $0.00006 = 174500
      expect(result.maxOutputTokens).toBe(Math.floor(10.47 / 0.000_06));
    });

    it('returns 0 max output tokens when cannot afford', () => {
      const result = calculateBudget({
        ...baseInput,
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 0, // No balance
      });
      expect(result.canAfford).toBe(false);
      expect(result.maxOutputTokens).toBe(0);
    });

    it('handles case where only minimum output is affordable', () => {
      // Create a scenario where we can barely afford minimum output
      const result = calculateBudget({
        ...baseInput,
        tier: 'paid',
        balanceCents: 10, // $0.10
        freeAllowanceCents: 0,
        promptCharacterCount: 400, // Small prompt
        modelInputPricePerToken: 0.000_01, // Cheap input
        modelOutputPricePerToken: 0.000_05, // Moderate output cost
      });
      expect(result.canAfford).toBe(true);
      expect(result.maxOutputTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    });
  });

  describe('capacity calculation', () => {
    it('calculates current usage as input tokens + minimum output tokens', () => {
      const result = calculateBudget(baseInput);
      expect(result.currentUsage).toBe(1000 + MINIMUM_OUTPUT_TOKENS);
    });

    it('calculates capacity percent correctly', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 4000, // 1000 tokens
        modelContextLength: 10_000, // Small context for easy math
      });
      // Current usage: 1000 + 1000 = 2000
      // Capacity: 2000 / 10000 = 20%
      expect(result.capacityPercent).toBeCloseTo(20, 10);
    });

    it('handles high capacity usage', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 40_000, // 10000 tokens
        modelContextLength: 12_000, // Small context
      });
      // Current usage: 10000 + 1000 = 11000
      // Capacity: 11000 / 12000 = 91.67%
      expect(result.capacityPercent).toBeCloseTo(91.67, 1);
    });

    it('can exceed 100% when over context limit', () => {
      const result = calculateBudget({
        ...baseInput,
        promptCharacterCount: 50_000, // 12500 tokens
        modelContextLength: 10_000,
      });
      // Current usage: 12500 + 1000 = 13500
      // Capacity: 13500 / 10000 = 135%
      expect(result.capacityPercent).toBeGreaterThan(100);
    });
  });
});

describe('generateBudgetErrors', () => {
  const baseResult: Omit<BudgetCalculationResult, 'errors'> = {
    canAfford: true,
    maxOutputTokens: 50_000,
    estimatedInputTokens: 1000,
    estimatedInputCost: 0.03,
    estimatedMinimumCost: 0.09,
    effectiveBalance: 10.5,
    currentUsage: 2000,
    capacityPercent: 20,
  };

  describe('capacity_exceeded', () => {
    it('shows error when capacity > 100%', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 101,
      });
      const error = errors.find((e) => e.id === 'capacity_exceeded');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
      expect(error?.message).toBe(
        'Message exceeds model capacity. Shorten your message or start a new conversation.'
      );
    });

    it('does not show when capacity <= 100%', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 100,
      });
      expect(errors.some((e) => e.id === 'capacity_exceeded')).toBe(false);
    });

    it('shows for all tiers', () => {
      const overCapacity = { ...baseResult, capacityPercent: 150 };
      expect(
        generateBudgetErrors('paid', overCapacity).some((e) => e.id === 'capacity_exceeded')
      ).toBe(true);
      expect(
        generateBudgetErrors('free', overCapacity).some((e) => e.id === 'capacity_exceeded')
      ).toBe(true);
      expect(
        generateBudgetErrors('guest', overCapacity).some((e) => e.id === 'capacity_exceeded')
      ).toBe(true);
    });
  });

  describe('capacity_warning', () => {
    it('shows warning when capacity >= 67% and <= 100%', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 67,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(true);
    });

    it('does not show warning when capacity < 67%', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 66,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(false);
    });

    it('does not show warning when capacity > 100% (capacity_exceeded shown instead)', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 110,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(false);
      expect(errors.some((e) => e.id === 'capacity_exceeded')).toBe(true);
    });

    it('does not show warning when cannot afford (insufficient error shown instead)', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 80,
        canAfford: false,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(false);
      expect(errors.some((e) => e.id === 'insufficient_paid')).toBe(true);
    });

    it('does not show warning for guest when insufficient_guest is shown', () => {
      const errors = generateBudgetErrors('guest', {
        ...baseResult,
        capacityPercent: 80,
        canAfford: false,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(false);
      expect(errors.some((e) => e.id === 'insufficient_guest')).toBe(true);
    });

    it('shows warning for all tiers when no blocking errors', () => {
      const highCapacity = { ...baseResult, capacityPercent: 80, canAfford: true };
      expect(
        generateBudgetErrors('paid', highCapacity).some((e) => e.id === 'capacity_warning')
      ).toBe(true);
      expect(
        generateBudgetErrors('free', highCapacity).some((e) => e.id === 'capacity_warning')
      ).toBe(true);
      expect(
        generateBudgetErrors('guest', highCapacity).some((e) => e.id === 'capacity_warning')
      ).toBe(true);
    });
  });

  describe('low_balance warning', () => {
    it('shows warning for paid users when maxOutputTokens < threshold and canAfford', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD - 1,
        canAfford: true,
      });
      expect(errors.some((e) => e.id === 'low_balance')).toBe(true);
    });

    it('does not show warning when maxOutputTokens >= threshold', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        maxOutputTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
        canAfford: true,
      });
      expect(errors.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('does not show warning for free users', () => {
      const errors = generateBudgetErrors('free', {
        ...baseResult,
        maxOutputTokens: 100,
        canAfford: true,
      });
      expect(errors.some((e) => e.id === 'low_balance')).toBe(false);
    });

    it('does not show warning when cannot afford', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        maxOutputTokens: 100,
        canAfford: false,
      });
      expect(errors.some((e) => e.id === 'low_balance')).toBe(false);
    });
  });

  describe('insufficient balance errors', () => {
    it('shows insufficient_paid for paid users when cannot afford', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        canAfford: false,
      });
      const error = errors.find((e) => e.id === 'insufficient_paid');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('shows insufficient_free for free users when cannot afford', () => {
      const errors = generateBudgetErrors('free', {
        ...baseResult,
        canAfford: false,
      });
      const error = errors.find((e) => e.id === 'insufficient_free');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('shows insufficient_guest for guests when cannot afford', () => {
      const errors = generateBudgetErrors('guest', {
        ...baseResult,
        canAfford: false,
      });
      const error = errors.find((e) => e.id === 'insufficient_guest');
      expect(error).toBeDefined();
      expect(error?.type).toBe('error');
    });

    it('does not show insufficient errors when can afford', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        canAfford: true,
      });
      expect(errors.some((e) => e.id === 'insufficient_paid')).toBe(false);
      expect(errors.some((e) => e.id === 'insufficient_free')).toBe(false);
      expect(errors.some((e) => e.id === 'insufficient_guest')).toBe(false);
    });
  });

  describe('tier info notices (always shown)', () => {
    it('shows free_tier_notice for free users always', () => {
      const errors = generateBudgetErrors('free', baseResult);
      const notice = errors.find((e) => e.id === 'free_tier_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
    });

    it('shows guest_notice for guests always', () => {
      const errors = generateBudgetErrors('guest', baseResult);
      const notice = errors.find((e) => e.id === 'guest_notice');
      expect(notice).toBeDefined();
      expect(notice?.type).toBe('info');
    });

    it('does not show tier notices for paid users', () => {
      const errors = generateBudgetErrors('paid', baseResult);
      expect(errors.some((e) => e.id === 'free_tier_notice')).toBe(false);
      expect(errors.some((e) => e.id === 'guest_notice')).toBe(false);
    });
  });

  describe('error message content', () => {
    it('capacity_warning has correct message', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 80,
      });
      const error = errors.find((e) => e.id === 'capacity_warning');
      expect(error?.message).toBe(
        "Your conversation is near this model's memory limit. Responses may be cut short."
      );
    });

    it('low_balance has correct message', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        maxOutputTokens: 100,
        canAfford: true,
      });
      const error = errors.find((e) => e.id === 'low_balance');
      expect(error?.message).toBe('Low balance. Long responses may be shortened.');
    });

    it('insufficient errors have correct messages', () => {
      const paidErrors = generateBudgetErrors('paid', { ...baseResult, canAfford: false });
      expect(paidErrors.find((e) => e.id === 'insufficient_paid')?.message).toBe(
        'Insufficient balance. Top up or try a more affordable model.'
      );

      const freeErrors = generateBudgetErrors('free', { ...baseResult, canAfford: false });
      expect(freeErrors.find((e) => e.id === 'insufficient_free')?.message).toBe(
        "Your free daily usage can't cover this message. Try a shorter conversation or more affordable model."
      );

      const guestErrors = generateBudgetErrors('guest', { ...baseResult, canAfford: false });
      expect(guestErrors.find((e) => e.id === 'insufficient_guest')?.message).toBe(
        'This message exceeds guest limits. Sign up for more capacity.'
      );
    });

    it('insufficient_paid has correct segments with link', () => {
      const errors = generateBudgetErrors('paid', { ...baseResult, canAfford: false });
      const error = errors.find((e) => e.id === 'insufficient_paid');
      expect(error?.segments).toEqual([
        { text: 'Insufficient balance. ' },
        { text: 'Top up', link: '/billing' },
        { text: ' or try a more affordable model.' },
      ]);
    });

    it('insufficient_guest has correct segments with link', () => {
      const errors = generateBudgetErrors('guest', { ...baseResult, canAfford: false });
      const error = errors.find((e) => e.id === 'insufficient_guest');
      expect(error?.segments).toEqual([
        { text: 'This message exceeds guest limits. ' },
        { text: 'Sign up', link: '/signup' },
        { text: ' for more capacity.' },
      ]);
    });

    it('tier notices have correct positive messages', () => {
      const freeErrors = generateBudgetErrors('free', baseResult);
      expect(freeErrors.find((e) => e.id === 'free_tier_notice')?.message).toBe(
        'Using free allowance. Top up for longer conversations.'
      );

      const guestErrors = generateBudgetErrors('guest', baseResult);
      expect(guestErrors.find((e) => e.id === 'guest_notice')?.message).toBe(
        'Free preview. Sign up for full access.'
      );
    });

    it('free_tier_notice has correct segments with link', () => {
      const errors = generateBudgetErrors('free', baseResult);
      const error = errors.find((e) => e.id === 'free_tier_notice');
      expect(error?.segments).toEqual([
        { text: 'Using free allowance. ' },
        { text: 'Top up', link: '/billing' },
        { text: ' for longer conversations.' },
      ]);
    });

    it('guest_notice has correct segments with link', () => {
      const errors = generateBudgetErrors('guest', baseResult);
      const error = errors.find((e) => e.id === 'guest_notice');
      expect(error?.segments).toEqual([
        { text: 'Free preview. ' },
        { text: 'Sign up', link: '/signup' },
        { text: ' for full access.' },
      ]);
    });
  });

  describe('multiple errors', () => {
    it('can show multiple warnings simultaneously', () => {
      const errors = generateBudgetErrors('paid', {
        ...baseResult,
        capacityPercent: 80,
        maxOutputTokens: 100,
        canAfford: true,
      });
      expect(errors.filter((e) => e.type === 'warning')).toHaveLength(2);
    });

    it('shows info notice alongside warnings for free users', () => {
      const errors = generateBudgetErrors('free', {
        ...baseResult,
        capacityPercent: 80,
      });
      expect(errors.some((e) => e.id === 'capacity_warning')).toBe(true);
      expect(errors.some((e) => e.id === 'free_tier_notice')).toBe(true);
    });

    it('shows info notice alongside error for guests', () => {
      const errors = generateBudgetErrors('guest', {
        ...baseResult,
        canAfford: false,
      });
      expect(errors.some((e) => e.id === 'insufficient_guest')).toBe(true);
      expect(errors.some((e) => e.id === 'guest_notice')).toBe(true);
    });
  });
});

describe('calculateBudget integration', () => {
  it('returns complete result with errors included', () => {
    const result = calculateBudget({
      tier: 'free',
      balanceCents: 0,
      freeAllowanceCents: 500,
      promptCharacterCount: 4000,
      modelInputPricePerToken: 0.000_03,
      modelOutputPricePerToken: 0.000_06,
      modelContextLength: 128_000,
    });

    expect(result).toHaveProperty('canAfford');
    expect(result).toHaveProperty('maxOutputTokens');
    expect(result).toHaveProperty('estimatedInputTokens');
    expect(result).toHaveProperty('estimatedInputCost');
    expect(result).toHaveProperty('estimatedMinimumCost');
    expect(result).toHaveProperty('effectiveBalance');
    expect(result).toHaveProperty('currentUsage');
    expect(result).toHaveProperty('capacityPercent');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('generates correct errors in result', () => {
    const result = calculateBudget({
      tier: 'guest',
      balanceCents: 0,
      freeAllowanceCents: 0,
      promptCharacterCount: 100,
      modelInputPricePerToken: 0.000_000_1,
      modelOutputPricePerToken: 0.000_000_1,
      modelContextLength: 10_000,
    });

    // Should have guest_notice info
    expect(result.errors.some((e) => e.id === 'guest_notice')).toBe(true);
  });
});

describe('constants verification', () => {
  it('uses correct character/token ratios', () => {
    expect(CHARS_PER_TOKEN_CONSERVATIVE).toBe(2);
    expect(CHARS_PER_TOKEN_STANDARD).toBe(4);
  });

  it('uses correct capacity thresholds', () => {
    expect(CAPACITY_RED_THRESHOLD).toBe(0.67);
    expect(CAPACITY_YELLOW_THRESHOLD).toBe(0.33);
  });

  it('uses correct budget constants', () => {
    expect(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS).toBe(50);
    expect(MAX_GUEST_MESSAGE_COST_CENTS).toBe(1);
    expect(MINIMUM_OUTPUT_TOKENS).toBe(1000);
    expect(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD).toBe(10_000);
  });
});
