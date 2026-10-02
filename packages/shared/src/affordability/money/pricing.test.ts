import { describe, it, expect } from 'vitest';
import { applyFees } from './pricing.ts';
import { TOTAL_FEE_RATE } from '../constants.ts';

describe('applyFees', () => {
  it('applies the total fee rate to the base price', () => {
    expect(applyFees(1)).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    expect(applyFees(10)).toBeCloseTo(10 * (1 + TOTAL_FEE_RATE), 10);
    expect(applyFees(100)).toBeCloseTo(100 * (1 + TOTAL_FEE_RATE), 10);
  });

  it('handles zero price', () => {
    expect(applyFees(0)).toBe(0);
  });

  it('handles very small prices', () => {
    expect(applyFees(0.000_01)).toBeCloseTo(0.000_01 * (1 + TOTAL_FEE_RATE), 10);
  });
});
