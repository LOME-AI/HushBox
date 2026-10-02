import { describe, expect, it } from 'vitest';
import {
  MARKUP_BASIS_POINTS,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  applyMarkup,
  assertMarkupMatchesSharedRate,
  billableRateToMaxPriceUsdPerMillion,
  providerUsdToBillableNanoUsd,
  roundHalfEvenDiv,
  usdToNanoUsd,
} from './money.js';

describe('MARKUP_BASIS_POINTS', () => {
  it('is the published 15%-over-provider-cost markup', () => {
    expect(MARKUP_BASIS_POINTS).toBe(1500n);
  });

  it('accepts the matching shared rate', () => {
    expect(() => {
      assertMarkupMatchesSharedRate(0.15);
    }).not.toThrow();
  });

  it('fails fast when the shared rate drifts', () => {
    expect(() => {
      assertMarkupMatchesSharedRate(0.2);
    }).toThrow(/update both together/);
  });
});

describe('storage rate constants', () => {
  it('re-export the exact integer nano-USD storage rates from the shared source', () => {
    expect(STORAGE_COST_PER_CHARACTER_NANO).toBe(300n);
    expect(MEDIA_STORAGE_COST_PER_BYTE_NANO).toBe(18n);
  });
});

describe('roundHalfEvenDiv', () => {
  it('divides exactly when there is no remainder', () => {
    expect(roundHalfEvenDiv(100n, 10n)).toBe(10n);
  });

  it('rounds down below the midpoint', () => {
    expect(roundHalfEvenDiv(14n, 10n)).toBe(1n);
  });

  it('rounds up above the midpoint', () => {
    expect(roundHalfEvenDiv(16n, 10n)).toBe(2n);
  });

  it('rounds a midpoint to the even neighbor going down', () => {
    expect(roundHalfEvenDiv(45n, 10n)).toBe(4n);
  });

  it('rounds a midpoint to the even neighbor going up', () => {
    expect(roundHalfEvenDiv(35n, 10n)).toBe(4n);
  });

  it('rounds negative midpoints to the even neighbor', () => {
    expect(roundHalfEvenDiv(-45n, 10n)).toBe(-4n);
    expect(roundHalfEvenDiv(-35n, 10n)).toBe(-4n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => roundHalfEvenDiv(1n, 0n)).toThrow(/positive/);
    expect(() => roundHalfEvenDiv(1n, -10n)).toThrow(/positive/);
  });
});

describe('applyMarkup', () => {
  it('adds 15% to a whole-dollar base cost', () => {
    expect(applyMarkup(1_000_000_000n)).toBe(1_150_000_000n);
  });

  it('returns zero for a zero base', () => {
    expect(applyMarkup(0n)).toBe(0n);
  });

  it('rounds a nano midpoint half-even up to the even neighbor', () => {
    // 10 × 1.15 = 11.5 → 12 (11 is odd)
    expect(applyMarkup(10n)).toBe(12n);
  });

  it('rounds a nano midpoint half-even down to the even neighbor', () => {
    // 30 × 1.15 = 34.5 → 34 (even)
    expect(applyMarkup(30n)).toBe(34n);
  });

  it('rejects a negative base cost', () => {
    expect(() => applyMarkup(-1n)).toThrow(/negative/);
  });
});

describe('providerUsdToBillableNanoUsd', () => {
  it('stays within one nano of the retired two-rounding composition', () => {
    // Realistic OpenRouter inline `usage.cost` figures (text and video scale)
    // plus rounding-hostile values. The retired composition rounded to nano,
    // then rounded the marked-up nano again; one rounding over the pico reading
    // may land a charge one nano away from it, never further.
    const recordedInlineCostsUsd = [
      0.000_184_5, 0.001_23, 0.004_262_5, 0.0165, 0.24, 1.038_745_5, 0.000_000_001, 0.000_000_030_5,
      0.007_163_999, 3.5,
    ];
    const retiredTwoRounding = (usd: number): bigint =>
      roundHalfEvenDiv(usdToNanoUsd(usd) * (10_000n + MARKUP_BASIS_POINTS), 10_000n);
    for (const usd of recordedInlineCostsUsd) {
      const drift = providerUsdToBillableNanoUsd(usd) - retiredTwoRounding(usd);
      expect([-1n, 0n, 1n]).toContain(drift);
    }
  });

  it('rounds a cost off the nano grid once, after the markup', () => {
    // 16,510 pico × 1.15 = 18,986.5 pico → 19 nano. Rounding to 17 nano first bills 20.
    expect(providerUsdToBillableNanoUsd(1.651e-8)).toBe(19n);
  });

  it('rounds a three-token cost at a rate off the nano grid once', () => {
    // 49,530 pico × 1.15 = 56,959.5 pico → 57 nano. Rounding to 50 nano first bills 58.
    expect(providerUsdToBillableNanoUsd(4.953e-8)).toBe(57n);
  });

  it('converts a whole-cent cost exactly', () => {
    expect(providerUsdToBillableNanoUsd(2.67)).toBe(3_070_500_000n);
  });

  it('bills a half-nano residue one nano above the retired composition', () => {
    // 30,500 pico × 1.15 = 35,075 pico → 35 nano; the retired path rounded 30.5 to 30 first and billed 34.
    expect(providerUsdToBillableNanoUsd(0.000_000_030_5)).toBe(35n);
  });

  it('adds exactly 15% to a whole-dollar inline cost', () => {
    expect(providerUsdToBillableNanoUsd(1)).toBe(1_150_000_000n);
  });

  it('rounds the markup half-even, not ceil', () => {
    // 30 nano × 1.15 = 34.5 → 34 (half-even, even neighbor); ceil would give 35.
    expect(providerUsdToBillableNanoUsd(0.000_000_03)).toBe(34n);
    // 10 nano × 1.15 = 11.5 → 12 (half-even, even neighbor); ceil agrees here.
    expect(providerUsdToBillableNanoUsd(0.000_000_01)).toBe(12n);
    // 2 nano × 1.15 = 2.3 → 2 (half-even, nearest neighbor); ceil would give 3.
    expect(providerUsdToBillableNanoUsd(0.000_000_002)).toBe(2n);
  });

  it('converts zero to zero', () => {
    expect(providerUsdToBillableNanoUsd(0)).toBe(0n);
  });

  it('rejects negative and non-finite inline costs', () => {
    expect(() => providerUsdToBillableNanoUsd(-0.01)).toThrow(/negative/);
    expect(() => providerUsdToBillableNanoUsd(Number.NaN)).toThrow(/finite/);
  });
});

describe('billableRateToMaxPriceUsdPerMillion', () => {
  it('un-bakes a billable rate to USD per million, rounded down to the pico grid', () => {
    // 4,313 nano ÷ 1.15 = 3,750,434.78… pico a token → 3,750,434 pico → $3.750434 per million.
    expect(billableRateToMaxPriceUsdPerMillion(4313n)).toBe('3.750434');
  });

  it('carries a whole-dollar part above one dollar per million', () => {
    expect(billableRateToMaxPriceUsdPerMillion(21_563n)).toBe('18.750434');
  });

  it('renders an exact quotient with all six fractional digits', () => {
    expect(billableRateToMaxPriceUsdPerMillion(8625n)).toBe('7.500000');
  });

  it('rounds down a quotient less than half a pico above a whole pico', () => {
    // 32,344 × 100,000 ÷ 115 = 28,125,217.39… → 28,125,217 pico.
    expect(billableRateToMaxPriceUsdPerMillion(32_344n)).toBe('28.125217');
  });

  it('pads a sub-dollar rate with leading fractional zeros', () => {
    expect(billableRateToMaxPriceUsdPerMillion(1n)).toBe('0.000869');
  });

  it('un-bakes a zero rate to zero', () => {
    expect(billableRateToMaxPriceUsdPerMillion(0n)).toBe('0.000000');
  });

  it('rejects a negative billable rate', () => {
    expect(() => billableRateToMaxPriceUsdPerMillion(-1n)).toThrow(/negative/);
  });
});

describe('usdToNanoUsd', () => {
  it('converts a whole-cent amount exactly', () => {
    expect(usdToNanoUsd(1.15)).toBe(1_150_000_000n);
  });

  it('converts zero', () => {
    expect(usdToNanoUsd(0)).toBe(0n);
  });

  it('converts one nano-USD exactly', () => {
    expect(usdToNanoUsd(0.000_000_001)).toBe(1n);
  });

  it('rounds a nano midpoint half-even to the even neighbor', () => {
    expect(usdToNanoUsd(0.000_000_000_5)).toBe(0n);
    expect(usdToNanoUsd(0.000_000_001_5)).toBe(2n);
  });

  it('rounds a residue below the nano midpoint down', () => {
    expect(usdToNanoUsd(0.000_000_001_4)).toBe(1n);
  });

  it('rejects negative amounts', () => {
    expect(() => usdToNanoUsd(-0.01)).toThrow(/negative/);
  });

  it('rejects non-finite amounts', () => {
    expect(() => usdToNanoUsd(Number.NaN)).toThrow(/finite/);
    expect(() => usdToNanoUsd(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
