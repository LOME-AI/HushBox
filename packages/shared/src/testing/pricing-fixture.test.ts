import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from './pricing-fixture.ts';

describe('tokenPricingFixture', () => {
  it('builds a schedule with no tiers from base rates alone', () => {
    expect(tokenPricingFixture({ input: 5n, output: 15n })).toEqual({
      kind: 'tokens',
      anchor: { base: { input: 5n, output: 15n }, tiers: [] },
    });
  });

  it('builds each tier from its threshold and rates', () => {
    const pricing = tokenPricingFixture({
      input: 4313n,
      output: 21_563n,
      tiers: [{ abovePromptTokens: 200_000, input: 8625n, output: 32_344n }],
    });
    expect(pricing.anchor.tiers).toEqual([
      { abovePromptTokens: 200_000, rates: { input: 8625n, output: 32_344n } },
    ]);
  });

  it('refuses a schedule the pricing schema refuses', () => {
    expect(() =>
      tokenPricingFixture({
        input: 100n,
        output: 400n,
        tiers: [{ abovePromptTokens: 128_000, input: 99n, output: 400n }],
      })
    ).toThrow(ZodError);
  });
});

describe('perImagePricingFixture', () => {
  it('builds a per-image price from its anchor and dearest unit', () => {
    expect(perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n })).toEqual({
      kind: 'perImage',
      anchor: 51_750_000n,
      dearest: 103_500_000n,
    });
  });

  it('refuses a dearest unit below the anchor', () => {
    expect(() => perImagePricingFixture({ anchor: 2n, dearest: 1n })).toThrow(ZodError);
  });
});

describe('perSecondPricingFixture', () => {
  it('builds a per-second price keyed by resolution', () => {
    expect(
      perSecondPricingFixture({
        anchor: { '720p': 128_800_000n },
        dearest: { '720p': 193_200_000n },
      })
    ).toEqual({
      kind: 'perSecond',
      anchor: { '720p': 128_800_000n },
      dearest: { '720p': 193_200_000n },
    });
  });

  it('refuses an anchor that names no resolution', () => {
    expect(() => perSecondPricingFixture({ anchor: {}, dearest: { '720p': 1n } })).toThrow(
      ZodError
    );
  });
});
