import { describe, expect, it } from 'vitest';

import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { TRIAL_AFFORDABILITY_MULTIPLIER, trialTurnCostNanoUsd } from './trial.ts';

describe('trialTurnCostNanoUsd', () => {
  it('prices the prompt’s input tokens and twice the minimum answer, provider cost only', () => {
    // 1,000 characters are 334 input tokens; the answer is 2 × 1,000 output
    // tokens; each is held at the ceiling of 100 / 1,000.
    const pricing = tokenPricingFixture({ input: 100n, output: 1000n });

    expect(trialTurnCostNanoUsd(pricing, 1000)).toBe(334n * 125n + 2000n * 1250n);
  });

  it('prices the answer at twice the minimum answer', () => {
    expect(TRIAL_AFFORDABILITY_MULTIPLIER).toBe(2);
  });

  it('prices an empty prompt at the answer alone', () => {
    const pricing = tokenPricingFixture({ input: 100n, output: 1000n });

    expect(trialTurnCostNanoUsd(pricing, 0)).toBe(2_500_000n);
  });

  it('prices a prompt past a long-context threshold at the tier', () => {
    const pricing = tokenPricingFixture({
      input: 100n,
      output: 1000n,
      tiers: [{ abovePromptTokens: 300, input: 200n, output: 2000n }],
    });

    expect(trialTurnCostNanoUsd(pricing, 1000)).toBe(334n * 250n + 2000n * 2500n);
  });
});
