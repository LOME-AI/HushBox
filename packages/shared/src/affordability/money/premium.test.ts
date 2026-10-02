import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from './nano-usd.ts';
import {
  MIN_POOL_FOR_PRICE_PERCENTILE,
  PREMIUM_PRICE_PERCENTILE,
  PREMIUM_RECENCY_MS,
  TRIAL_AFFORDABILITY_MULTIPLIER,
  combinedRateNanoUsd,
  exceedsTrialBudget,
  isPremiumModel,
  premiumPriceThresholdNanoUsd,
} from './premium.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';

const NOW_MS = TEST_DAY_START;
/** Old enough that the recency leg never fires: 400 days before `NOW_MS`. */
const OLD_RELEASE_MS = NOW_MS - 400 * 24 * 60 * 60 * 1000;

function modelFor(overrides: Partial<PriceableModel> = {}): PriceableModel {
  return {
    modelId: modelId('vendor/model'),
    pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
    contextLength: 128_000,
    providerCap: undefined,
    releasedAtMs: OLD_RELEASE_MS,
    reasoning: undefined,
    ...overrides,
  };
}

describe('PREMIUM_PRICE_PERCENTILE', () => {
  it('is the 75th percentile', () => {
    expect(PREMIUM_PRICE_PERCENTILE).toBe(0.75);
  });
});

describe('PREMIUM_RECENCY_MS', () => {
  it('is 182 days in milliseconds', () => {
    expect(PREMIUM_RECENCY_MS).toBe(182 * 24 * 60 * 60 * 1000);
  });
});

describe('TRIAL_AFFORDABILITY_MULTIPLIER', () => {
  it('is 2 — a model must afford twice the minimum answer', () => {
    expect(TRIAL_AFFORDABILITY_MULTIPLIER).toBe(2);
  });
});

describe('combinedRateNanoUsd', () => {
  it('sums the billable input and output per-token rates as exact bigints', () => {
    expect(combinedRateNanoUsd(modelFor())).toBe(3000n);
  });

  it('stays exact at magnitudes a float would round', () => {
    const model = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(9_007_199_254_740_993n), output: nanoUSD(1n) }),
    });
    expect(combinedRateNanoUsd(model)).toBe(9_007_199_254_740_994n);
  });
});

describe('isPremiumModel — the price leg', () => {
  const base = { releasedAtMs: OLD_RELEASE_MS, nowMs: NOW_MS };

  it('classifies a model at exactly the threshold as premium', () => {
    expect(
      isPremiumModel({ ...base, model: modelFor(), priceThresholdNanoUsd: nanoUSD(3000n) })
    ).toBe(true);
  });

  it('classifies a model one nano-USD above the threshold as premium', () => {
    expect(
      isPremiumModel({ ...base, model: modelFor(), priceThresholdNanoUsd: nanoUSD(2999n) })
    ).toBe(true);
  });

  it('classifies a model one nano-USD below the threshold as basic', () => {
    expect(
      isPremiumModel({ ...base, model: modelFor(), priceThresholdNanoUsd: nanoUSD(3001n) })
    ).toBe(false);
  });

  it('decides the boundary on exact bigints, never on a rounded float', () => {
    // Both rates land beyond 2^53, where float addition silently rounds: the
    // sum is one nano below the threshold, and a `Number()` path reads equal.
    const model = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(9_007_199_254_740_992n), output: nanoUSD(1n) }),
    });
    expect(
      isPremiumModel({
        ...base,
        model,
        priceThresholdNanoUsd: nanoUSD(9_007_199_254_740_994n),
      })
    ).toBe(false);
    expect(Number(9_007_199_254_740_992n) + Number(1n)).toBe(
      Number(9_007_199_254_740_994n) - Number(1n)
    );
  });
});

describe('isPremiumModel — the recency leg', () => {
  it('classifies a cheap model released inside the window as premium', () => {
    expect(
      isPremiumModel({
        model: modelFor({
          pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(1n) }),
          releasedAtMs: NOW_MS - 100 * 24 * 60 * 60 * 1000,
        }),
        priceThresholdNanoUsd: nanoUSD(1_000_000n),
        nowMs: NOW_MS,
      })
    ).toBe(true);
  });

  it('classifies a cheap model released outside the window as basic', () => {
    expect(
      isPremiumModel({
        model: modelFor({
          pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(1n) }),
        }),
        priceThresholdNanoUsd: nanoUSD(1_000_000n),
        nowMs: NOW_MS,
      })
    ).toBe(false);
  });

  it('reads its clock from the caller, so the same inputs always classify alike', () => {
    const input = {
      model: modelFor({
        pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(1n) }),
        releasedAtMs: NOW_MS - PREMIUM_RECENCY_MS + 1,
      }),
      priceThresholdNanoUsd: nanoUSD(1_000_000n),
    };
    expect(isPremiumModel({ ...input, nowMs: NOW_MS })).toBe(true);
    expect(isPremiumModel({ ...input, nowMs: NOW_MS + PREMIUM_RECENCY_MS })).toBe(false);
  });
});

describe('exceedsTrialBudget', () => {
  const promptChars = 400;

  it('refuses a model whose worst case runs past the trial per-message cap', () => {
    // $0.0000092/output token billable ⇒ 2000 tokens alone is ~1.8¢.
    const model = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(2300n), output: nanoUSD(9200n) }),
    });
    expect(exceedsTrialBudget(model, promptChars)).toBe(true);
  });

  it('admits a model whose worst case fits the cap', () => {
    const model = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(1n) }),
    });
    expect(exceedsTrialBudget(model, promptChars)).toBe(false);
  });

  it('charges the input leg, so a longer system prompt can push a model over', () => {
    // At 3 chars/token, 7500 chars ⇒ 2500 tokens × 4200 nano = 10.5 mn nano,
    // just past the 1¢ (10 mn nano) per-message cap.
    const model = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(4200n), output: nanoUSD(1n) }),
    });
    expect(exceedsTrialBudget(model, 0)).toBe(false);
    expect(exceedsTrialBudget(model, 7500)).toBe(true);
  });

  it('prices already-billable rates, never re-applying the fee', () => {
    // The estimator core takes billable rates. A model priced exactly at the
    // cap for 2× the minimum answer must not tip over from a second markup.
    const cheap = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(1n) }),
    });
    const dearer = modelFor({
      pricing: tokenPricingFixture({ input: nanoUSD(1n), output: nanoUSD(2n) }),
    });
    expect(exceedsTrialBudget(cheap, 0)).toBe(false);
    expect(exceedsTrialBudget(dearer, 0)).toBe(false);
  });

  it('rejects a negative system-prompt length rather than pricing it', () => {
    expect(() => exceedsTrialBudget(modelFor(), -1)).toThrow(RangeError);
  });
});

describe('premiumPriceThresholdNanoUsd — the pool percentile the price leg compares', () => {
  function poolOf(rates: readonly bigint[]): readonly PriceableModel[] {
    return rates.map((rate, index) =>
      modelFor({
        modelId: modelId(`vendor/m${String(index)}`),
        // A rate is positive, so the input leg carries 1 of the combined rate.
        pricing: tokenPricingFixture({ input: 1n, output: rate - 1n }),
      })
    );
  }

  it('is the combined rate at floor(n × 0.75) of the ascending pool', () => {
    // floor(4 × 0.75) = 3, so a four-model pool ranks its threshold at the top
    // rate — the same index the shipped trial gate selected.
    expect(premiumPriceThresholdNanoUsd(poolOf([10n, 20n, 30n, 40n]))).toBe(40n);
  });

  it('is order-independent — the pool is a set, not a row order', () => {
    expect(premiumPriceThresholdNanoUsd(poolOf([40n, 10n, 30n, 20n]))).toBe(40n);
  });

  it('has no threshold below the minimum pool, so a tiny catalog cannot mark itself premium', () => {
    expect(premiumPriceThresholdNanoUsd(poolOf([10n, 20n, 30n]))).toBeUndefined();
    expect(MIN_POOL_FOR_PRICE_PERCENTILE).toBe(4);
  });

  it('leaves the recency leg deciding when there is no threshold', () => {
    const fresh = modelFor({ releasedAtMs: NOW_MS - 1000 });
    expect(isPremiumModel({ model: fresh, nowMs: NOW_MS })).toBe(true);
    expect(isPremiumModel({ model: modelFor(), nowMs: NOW_MS })).toBe(false);
  });
});
