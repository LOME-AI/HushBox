import { describe, expect, it } from 'vitest';

import { NANO_USD_PER_CENT } from './money/nano-usd.ts';
import { freeDailyAllowanceNanoUsd } from './free-allowance.ts';
import { FREE_ALLOWANCE_CENTS_VALUE } from './money/tiers.ts';

describe('freeDailyAllowanceNanoUsd', () => {
  it('is the free tier’s declared daily allowance, converted exactly', () => {
    expect(freeDailyAllowanceNanoUsd()).toBe(
      BigInt(FREE_ALLOWANCE_CENTS_VALUE) * NANO_USD_PER_CENT
    );
  });

  it('is a positive amount — a free payer with nothing spendable has no free tier', () => {
    expect(freeDailyAllowanceNanoUsd()).toBeGreaterThan(0n);
  });
});
