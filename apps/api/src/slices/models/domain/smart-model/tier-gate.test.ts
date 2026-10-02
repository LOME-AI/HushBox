import { describe, expect, it } from 'vitest';

import { DAY_MS, OLD_RELEASE_SECONDS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { findTierLockedModel } from './tier-gate.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';

// A fixed reference clock; recency is judged against it, not the wall clock.
const NOW_MS = TEST_DAY_START;
// releasedAt 100 days back — inside the 182-day recency window.
const RECENT_RELEASE = secondsAt(NOW_MS - 100 * DAY_MS);

function pricing(inputPerToken: bigint, outputPerToken: bigint): ModelDescriptor['pricing'] {
  return tokenPricingFixture({ input: inputPerToken, output: outputPerToken });
}

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: pricing(1n, 1n),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

/** A spread of cheap-to-expensive text models for the price percentile. */
function priceSpread(prices: readonly bigint[]): ModelDescriptor[] {
  return prices.map((combined, index) =>
    model({ id: `spread/${String(index)}`, pricing: pricing(combined - 1n, 1n) })
  );
}

describe('findTierLockedModel', () => {
  it('returns undefined when the caller can access premium, even for a premium model', () => {
    const premium = model({ id: 'test/expensive', pricing: pricing(99n, 1n) });
    const catalog = [...priceSpread([10n, 20n, 30n]), premium];
    expect(findTierLockedModel([premium.id], catalog, true, NOW_MS)).toBeUndefined();
  });

  it('returns a top-quartile-priced model for a caller who cannot access premium', () => {
    const premium = model({ id: 'test/expensive', pricing: pricing(99n, 1n) });
    const catalog = [...priceSpread([10n, 20n, 30n]), premium];
    expect(findTierLockedModel([premium.id], catalog, false, NOW_MS)).toBe(premium);
  });

  it('returns undefined for a cheap, old, below-quartile model when premium is unavailable', () => {
    const cheap = model({
      id: 'test/cheap',
      pricing: pricing(1n, 1n),
      releasedAt: OLD_RELEASE_SECONDS,
    });
    const catalog = [cheap, ...priceSpread([1000n, 2000n, 3000n])];
    expect(findTierLockedModel([cheap.id], catalog, false, NOW_MS)).toBeUndefined();
  });

  it('locks on the first premium model in selection order for a multi-model send', () => {
    const cheap = model({
      id: 'test/cheap',
      pricing: pricing(1n, 1n),
      releasedAt: OLD_RELEASE_SECONDS,
    });
    const premiumA = model({ id: 'test/premiumA', pricing: pricing(99n, 1n) });
    const premiumB = model({ id: 'test/premiumB', pricing: pricing(199n, 1n) });
    const catalog = [cheap, ...priceSpread([10n, 20n, 30n]), premiumA, premiumB];
    expect(findTierLockedModel([cheap.id, premiumA.id, premiumB.id], catalog, false, NOW_MS)).toBe(
      premiumA
    );
  });

  it('detects a recently released model as premium (recency leg)', () => {
    const recent = model({
      id: 'test/recent',
      pricing: pricing(1n, 1n),
      releasedAt: RECENT_RELEASE,
    });
    const catalog = [recent, ...priceSpread([1000n, 2000n, 3000n])];
    expect(findTierLockedModel([recent.id], catalog, false, NOW_MS)).toBe(recent);
  });

  it('detects a per-token-expensive model as premium (minimal-exchange affordability leg)', () => {
    const dear = model({
      id: 'test/dear',
      pricing: pricing(1n, 5999n),
      releasedAt: OLD_RELEASE_SECONDS,
    });
    const catalog = [dear, ...priceSpread([6000n, 6000n, 6000n])];
    expect(findTierLockedModel([dear.id], catalog, false, NOW_MS)).toBe(dear);
  });

  it('does not lock a non-text (media) model — only premium text models are gated', () => {
    const image = model({ id: 'test/image', outputs: ['image'] as Modality[] });
    const catalog = [image, ...priceSpread([10n, 20n, 30n])];
    expect(findTierLockedModel([image.id], catalog, false, NOW_MS)).toBeUndefined();
  });

  it('skips a selected id absent from the exposed catalog (the build refuses an unknown model)', () => {
    const catalog = priceSpread([10n, 20n, 30n, 40n]);
    expect(findTierLockedModel(['unknown/model'], catalog, false, NOW_MS)).toBeUndefined();
  });
});
