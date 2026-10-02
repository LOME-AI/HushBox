import { describe, expect, it } from 'vitest';

import { MAX_ALLOWED_NEGATIVE_BALANCE_CENTS, MAX_TRIAL_MESSAGE_COST_CENTS } from '../constants.ts';
import { NANO_USD_PER_CENT } from '../money/nano-usd.ts';
import {
  PAID_CUSHION_NANO_USD,
  computePromptCapacity,
  getCushionNano,
  getEffectiveBalanceNano,
  spendableFundsNanoUsd,
} from './pre-adapters.ts';

describe('PAID_CUSHION_NANO_USD', () => {
  it('is the $0.50 negative-balance cushion in nano-USD', () => {
    expect(PAID_CUSHION_NANO_USD).toBe(
      BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * NANO_USD_PER_CENT
    );
  });
});

describe('getCushionNano', () => {
  it('grants the cushion to a purchased balance that is still positive', () => {
    expect(getCushionNano(1n)).toBe(PAID_CUSHION_NANO_USD);
  });

  it('grants no cushion to a balance spent to zero', () => {
    expect(getCushionNano(0n)).toBe(0n);
  });

  it('grants no cushion to an already overdrawn balance', () => {
    expect(getCushionNano(-1n)).toBe(0n);
  });
});

describe('spendableFundsNanoUsd', () => {
  it('adds the cushion to a positive purchased balance', () => {
    expect(spendableFundsNanoUsd(1_000_000n)).toBe(1_000_000n + PAID_CUSHION_NANO_USD);
  });

  it('leaves a balance spent to zero at zero', () => {
    expect(spendableFundsNanoUsd(0n)).toBe(0n);
  });

  it('does not lift an overdrawn balance back toward solvency', () => {
    expect(spendableFundsNanoUsd(-100n)).toBe(-100n);
  });
});

describe('getEffectiveBalanceNano', () => {
  it('caps the trial at the fixed max message cost', () => {
    // The trial alone: a link guest HAS a funding door and is owner-funded, so
    // it is excluded from the parameter type and cannot be handed this ceiling
    // (§Affordability 8). There is no runtime arm left to assert against —
    // `getEffectiveBalanceNano('guest', …)` is a compile error.
    const trialFixed = BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;
    expect(getEffectiveBalanceNano('trial', 999n, 999n)).toBe(trialFixed);
  });

  it('uses only the free allowance for free users', () => {
    expect(getEffectiveBalanceNano('free', 5_000_000_000n, 500_000n)).toBe(500_000n);
  });

  it('adds the cushion to the balance for paid users', () => {
    expect(getEffectiveBalanceNano('paid', 2_000_000n, 0n)).toBe(
      2_000_000n + PAID_CUSHION_NANO_USD
    );
  });
});

describe('computePromptCapacity', () => {
  it('reports usage as input tokens (3 chars/token) plus the minimum output reserve', () => {
    // 3000 chars / 3 = 1000 input tokens + 1000 minimum output = 2000 of 10000 -> 20%
    const capacity = computePromptCapacity({
      promptCharacterCount: 3000,
      modelContextLength: 10_000,
    });
    expect(capacity.currentUsage).toBe(2000);
    expect(capacity.maxCapacity).toBe(10_000);
    expect(capacity.capacityPercent).toBeCloseTo(20);
  });

  it('reports zero percent when the context length is unknown', () => {
    const capacity = computePromptCapacity({ promptCharacterCount: 4000, modelContextLength: 0 });
    expect(capacity.capacityPercent).toBe(0);
  });
});
