import { describe, expect, it } from 'vitest';

import { GROWTH_CEILINGS } from './ceilings.ts';

describe('GROWTH_CEILINGS', () => {
  it('caps any one set at 100,000 members per bucket', () => {
    expect(GROWTH_CEILINGS.set).toBe(100_000);
  });

  it('caps how many distinct visitor identities one address may mint in a day', () => {
    expect(GROWTH_CEILINGS.mint).toBe(1000);
  });

  it('keeps the mint ceiling far enough below the set ceiling that many addresses are needed to fill a set', () => {
    expect(GROWTH_CEILINGS.set / GROWTH_CEILINGS.mint).toBeGreaterThanOrEqual(100);
  });

  it('caps the distinct dimension values each family may open in one bucket', () => {
    expect(GROWTH_CEILINGS.index).toEqual({
      paths: 500,
      referrers: 1000,
      geo: 1000,
      events: 2000,
      reach: 5000,
    });
  });
});
