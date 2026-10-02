import { describe, expect, it } from 'vitest';
import { trialDailyMessageAllowance } from './trial-allowance.ts';
import { TRIAL_MESSAGE_LIMIT } from './money/tiers.ts';

describe('trialDailyMessageAllowance', () => {
  it('is the trial tier’s declared daily allowance, not a second figure beside it', () => {
    expect(trialDailyMessageAllowance()).toBe(TRIAL_MESSAGE_LIMIT);
  });

  it('is a positive count — a trial with no messages is not a preview', () => {
    expect(trialDailyMessageAllowance()).toBeGreaterThan(0);
    expect(Number.isInteger(trialDailyMessageAllowance())).toBe(true);
  });
});
