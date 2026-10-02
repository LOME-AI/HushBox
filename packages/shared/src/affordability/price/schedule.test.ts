import { describe, expect, it } from 'vitest';

import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '../../testing/pricing-fixture.ts';
import { expectCompileTimeProof } from '../../testing/test-assertions.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import {
  ceilingOf,
  mediaRatesFor,
  ModelPricingSchema,
  PRICE_CEILING_MULTIPLE,
  resolveTier,
  scheduleFor,
} from './schedule.ts';
import type { MediaPricing, ModelPricing, TokenPriceSchedule, TokenPricing } from './schedule.ts';

const schedule: TokenPriceSchedule = {
  base: { input: nanoUSD(4313n), output: nanoUSD(21_563n) },
  tiers: [
    { abovePromptTokens: 200_000, rates: { input: nanoUSD(8625n), output: nanoUSD(32_344n) } },
  ],
};

const twoTiers: TokenPriceSchedule = {
  base: { input: nanoUSD(100n), output: nanoUSD(400n) },
  tiers: [
    { abovePromptTokens: 128_000, rates: { input: nanoUSD(150n), output: nanoUSD(500n) } },
    { abovePromptTokens: 272_000, rates: { input: nanoUSD(200n), output: nanoUSD(800n) } },
  ],
};

describe('a price written field by field as a literal', () => {
  it('is not a ModelPricing', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error a field-by-field literal carries no brand
      const pricing: ModelPricing = { kind: 'tokens', anchor: schedule };
      return pricing;
    });
  });

  it('is not a TokenPricing', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error a field-by-field literal carries no brand
      const pricing: TokenPricing = { kind: 'tokens', anchor: schedule };
      return pricing;
    });
  });

  it('is not a MediaPricing', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error a field-by-field literal carries no brand
      const pricing: MediaPricing = { kind: 'perImage', anchor: nanoUSD(1n), dearest: nanoUSD(1n) };
      return pricing;
    });
  });
});

describe('resolveTier', () => {
  it('prices a prompt of exactly the threshold at base', () => {
    const resolved = resolveTier(schedule, 200_000);
    expect(resolved.tier).toBe(0);
    expect(resolved.rates).toBe(schedule.base);
  });

  it('prices a prompt one token over the threshold at the tier', () => {
    const resolved = resolveTier(schedule, 200_001);
    expect(resolved.tier).toBe(1);
    expect(resolved.rates).toBe(schedule.tiers[0]?.rates);
  });

  it('prices an empty prompt at base', () => {
    expect(resolveTier(schedule, 0).tier).toBe(0);
  });

  it('prices every prompt at base when the schedule has no tiers', () => {
    expect(resolveTier({ base: schedule.base, tiers: [] }, 5_000_000).tier).toBe(0);
  });

  it('takes the last tier a prompt exceeds when it exceeds several', () => {
    const resolved = resolveTier(twoTiers, 272_001);
    expect(resolved.tier).toBe(2);
    expect(resolved.rates).toBe(twoTiers.tiers[1]?.rates);
  });

  it('stops at the lower tier for a prompt between two thresholds', () => {
    expect(resolveTier(twoTiers, 272_000).tier).toBe(1);
  });

  it.each([-1, 1.5, Number.NaN])('refuses a prompt token count of %s', (promptTokens) => {
    expect(() => resolveTier(schedule, promptTokens)).toThrow(RangeError);
  });
});

describe('scheduleFor', () => {
  const pricing = tokenPricingFixture({
    input: 4313n,
    output: 21_563n,
    tiers: [{ abovePromptTokens: 200_000, input: 8625n, output: 32_344n }],
  });

  it.each(['display', 'estimatedCharge'] as const)('reads the anchor for %s', (use) => {
    expect(scheduleFor(pricing, use)).toBe(pricing.anchor);
  });

  it('reads the ceiling of the anchor for a reserve', () => {
    expect(scheduleFor(pricing, 'reserve')).toEqual(ceilingOf(pricing.anchor));
  });
});

describe('ceilingOf', () => {
  /** Sonnet 4.5's anchor: base rates, and dearer rates past 200,000 prompt tokens. */
  const anchor: TokenPriceSchedule = {
    base: { input: nanoUSD(3450n), output: nanoUSD(17_250n) },
    tiers: [
      { abovePromptTokens: 200_000, rates: { input: nanoUSD(6900n), output: nanoUSD(25_875n) } },
    ],
  };

  it('is five quarters of the anchor', () => {
    expect(PRICE_CEILING_MULTIPLE).toEqual({ numerator: 5n, denominator: 4n });
  });

  it('raises each base rate to five quarters, rounded up', () => {
    expect(ceilingOf(anchor).base).toEqual({ input: 4313n, output: 21_563n });
  });

  it('raises each tier rate to five quarters, rounded up, at the same threshold', () => {
    expect(ceilingOf(anchor).tiers).toEqual([
      { abovePromptTokens: 200_000, rates: { input: 8625n, output: 32_344n } },
    ]);
  });

  it('rounds a rate whose five quarters fall a quarter past a whole nano up to the next', () => {
    const cheap: TokenPriceSchedule = {
      base: { input: nanoUSD(173n), output: nanoUSD(173n) },
      tiers: [],
    };

    expect(ceilingOf(cheap).base.input).toBe(217n);
  });

  it('holds an input rate that covers a 5-minute cache write listed at five quarters of the prompt rate', () => {
    const cacheWriteNanoUsd = 2875n;
    const listed: TokenPriceSchedule = {
      base: { input: nanoUSD(2300n), output: nanoUSD(9200n) },
      tiers: [],
    };

    expect(ceilingOf(listed).base.input).toBe(cacheWriteNanoUsd);
  });
});

describe('mediaRatesFor', () => {
  const image = perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n });
  const video = perSecondPricingFixture({
    anchor: { '720p': 128_800_000n },
    dearest: { '720p': 193_200_000n },
  });

  it.each(['display', 'estimatedCharge'] as const)('reads an image anchor for %s', (use) => {
    expect(mediaRatesFor(image, use)).toBe(image.anchor);
  });

  it('reads the dearest image unit for a reserve', () => {
    expect(mediaRatesFor(image, 'reserve')).toBe(image.dearest);
  });

  it.each(['display', 'estimatedCharge'] as const)('reads a per-second anchor for %s', (use) => {
    expect(mediaRatesFor(video, use)).toBe(video.anchor);
  });

  it('reads the dearest per-second rates for a reserve', () => {
    expect(mediaRatesFor(video, 'reserve')).toBe(video.dearest);
  });
});

describe('ModelPricingSchema', () => {
  const wireSchedule = {
    base: { input: '100', output: '400' },
    tiers: [
      { abovePromptTokens: 128_000, rates: { input: '150', output: '500' } },
      { abovePromptTokens: 272_000, rates: { input: '200', output: '800' } },
    ],
  };

  it('parses a token schedule into branded amounts', () => {
    expect(ModelPricingSchema.parse({ kind: 'tokens', anchor: wireSchedule })).toEqual({
      kind: 'tokens',
      anchor: twoTiers,
    });
  });

  it('parses a schedule with no tiers', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: { base: { input: '1', output: '1' }, tiers: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a tier that keeps the rates of the tier below it', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        base: { input: '100', output: '400' },
        tiers: [{ abovePromptTokens: 128_000, rates: { input: '100', output: '400' } }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a per-image price', () => {
    expect(
      ModelPricingSchema.parse({ kind: 'perImage', anchor: '51750000', dearest: '103500000' })
    ).toEqual({ kind: 'perImage', anchor: 51_750_000n, dearest: 103_500_000n });
  });

  it('parses a per-second price', () => {
    expect(
      ModelPricingSchema.parse({
        kind: 'perSecond',
        anchor: { '720p': '128800000' },
        dearest: { '720p': '193200000' },
      })
    ).toEqual({
      kind: 'perSecond',
      anchor: { '720p': 128_800_000n },
      dearest: { '720p': 193_200_000n },
    });
  });

  it('refuses tier thresholds that are not strictly ascending', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        ...wireSchedule,
        tiers: [
          { abovePromptTokens: 200_000, rates: { input: '150', output: '500' } },
          { abovePromptTokens: 200_000, rates: { input: '200', output: '800' } },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a first tier whose rate falls below base', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        base: { input: '100', output: '400' },
        tiers: [{ abovePromptTokens: 128_000, rates: { input: '150', output: '399' } }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a later tier whose input rate falls below the tier before it', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        ...wireSchedule,
        tiers: [
          { abovePromptTokens: 128_000, rates: { input: '150', output: '500' } },
          { abovePromptTokens: 272_000, rates: { input: '149', output: '800' } },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a later tier whose output rate falls below the tier before it', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        ...wireSchedule,
        tiers: [
          { abovePromptTokens: 128_000, rates: { input: '150', output: '500' } },
          { abovePromptTokens: 272_000, rates: { input: '200', output: '499' } },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it.each(['0', '-1'])('refuses a token rate of %s', (input) => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: { base: { input, output: '400' }, tiers: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a token rate that is not a canonical decimal', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: { base: { input: '1.5', output: '400' }, tiers: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a per-image rate of zero', () => {
    const parsed = ModelPricingSchema.safeParse({ kind: 'perImage', anchor: '0', dearest: '1' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a per-second rate of zero', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'perSecond',
      anchor: { '720p': '0' },
      dearest: { '720p': '1' },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a per-image dearest rate below its anchor', () => {
    const parsed = ModelPricingSchema.safeParse({ kind: 'perImage', anchor: '2', dearest: '1' });
    expect(parsed.success).toBe(false);
  });

  it('parses a per-image dearest rate equal to its anchor', () => {
    const parsed = ModelPricingSchema.safeParse({ kind: 'perImage', anchor: '2', dearest: '2' });
    expect(parsed.success).toBe(true);
  });

  it('refuses a per-second dearest rate below its anchor at one resolution', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'perSecond',
      anchor: { '720p': '5', '1080p': '9' },
      dearest: { '720p': '6', '1080p': '8' },
    });
    expect(parsed.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [['dearest', '1080p'], 'a dearest rate must not fall below its anchor'],
    ]);
  });

  it('refuses a per-second dearest price missing a resolution the anchor carries', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'perSecond',
      anchor: { '720p': '5', '1080p': '9' },
      dearest: { '720p': '6' },
    });
    expect(parsed.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [['dearest', '1080p'], 'the dearest side must price every resolution the anchor prices'],
    ]);
  });

  it('parses a per-second dearest price that carries a resolution the anchor lacks', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'perSecond',
      anchor: { '720p': '5' },
      dearest: { '720p': '5', '1080p': '9' },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a per-second price whose anchor names no resolution', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'perSecond',
      anchor: {},
      dearest: { '720p': '5' },
    });
    expect(parsed.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [['anchor'], 'a per-second anchor must price at least one resolution'],
    ]);
  });

  it('refuses a fractional tier threshold', () => {
    const parsed = ModelPricingSchema.safeParse({
      kind: 'tokens',
      anchor: {
        ...wireSchedule,
        tiers: [{ abovePromptTokens: 1.5, rates: { input: '150', output: '500' } }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown pricing kind', () => {
    expect(ModelPricingSchema.safeParse({ kind: 'perToken', anchor: '1' }).success).toBe(false);
  });
});
