import { describe, expect, it } from 'vitest';

import { getEffectiveBalanceNano } from './estimate/pre-adapters.ts';
import { trialFundingSnapshot } from './trial-funding.ts';

describe('trialFundingSnapshot', () => {
  it('carries the tier authority’s fixed trial ceiling as the spendable figure', () => {
    expect(BigInt(trialFundingSnapshot().spendableNanoUsd)).toBe(
      getEffectiveBalanceNano('trial', 0n, 0n)
    );
  });

  it('holds nothing — a payer with no funding door can have no hold out', () => {
    expect(BigInt(trialFundingSnapshot().heldNanoUsd)).toBe(0n);
  });

  it('names the trial as its own payer, so no other tier can read this snapshot', () => {
    expect(trialFundingSnapshot()).toMatchObject({ payerTier: 'trial', payer: 'self' });
  });

  it('is a positive ceiling — a zero would refuse the whole unauthenticated funnel', () => {
    expect(BigInt(trialFundingSnapshot().spendableNanoUsd)).toBeGreaterThan(0n);
  });
});
