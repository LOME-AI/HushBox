import { describe, expect, it } from 'vitest';

import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '../../testing/pricing-fixture.ts';
import { mediaPricingOf, pricingFromWire, pricingToWire, tokenPricingOf } from './wire.ts';
import type { Model } from '../../schemas/api/models.ts';

function wireRow(overrides: Partial<Model>): Model {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    provider: 'vendor',
    modality: 'text',
    contextLength: 200_000,
    pricing: {},
    description: 'a model',
    supportedParameters: [],
    ...overrides,
  };
}

describe('pricingFromWire', () => {
  it('reads a text row’s two served rates as an untiered token schedule', () => {
    const row = wireRow({ pricing: { inputPerToken: '300', outputPerToken: '1500' } });

    expect(pricingFromWire(row)).toEqual(tokenPricingFixture({ input: 300n, output: 1500n }));
  });

  it('reads a text row’s long-context rates as the schedule’s tiers', () => {
    const row = wireRow({
      pricing: {
        inputPerToken: '3450',
        outputPerToken: '17250',
        longContextRates: [
          { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
        ],
      },
    });

    expect(pricingFromWire(row)).toEqual(
      tokenPricingFixture({
        input: 3450n,
        output: 17_250n,
        tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
      })
    );
  });

  it('reads an image row’s two served rates as the two sides of its price', () => {
    const row = wireRow({
      modality: 'image',
      contextLength: 0,
      pricing: { perImage: '40000', dearestPerImage: '90000' },
    });

    expect(pricingFromWire(row)).toEqual(
      perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n })
    );
  });

  it('reads a video row’s two served matrices as the two sides of its price', () => {
    const row = wireRow({
      modality: 'video',
      contextLength: 0,
      pricing: {
        perSecondByResolution: { '720p': '100', '1080p': '200' },
        dearestPerSecondByResolution: { '720p': '300', '1080p': '600' },
      },
    });

    expect(pricingFromWire(row)).toEqual(
      perSecondPricingFixture({
        anchor: { '720p': 100n, '1080p': 200n },
        dearest: { '720p': 300n, '1080p': 600n },
      })
    );
  });

  it('leaves an image row that serves no dearest rate unpriced rather than reserving its anchor', () => {
    const row = wireRow({ modality: 'image', contextLength: 0, pricing: { perImage: '40000' } });

    expect(pricingFromWire(row)).toBeUndefined();
  });

  it('leaves a video row that serves no dearest matrix unpriced', () => {
    const row = wireRow({
      modality: 'video',
      contextLength: 0,
      pricing: { perSecondByResolution: { '720p': '100' } },
    });

    expect(pricingFromWire(row)).toBeUndefined();
  });

  it('leaves a text row with one rate leg unpriced rather than pricing the other free', () => {
    expect(pricingFromWire(wireRow({ pricing: { inputPerToken: '300' } }))).toBeUndefined();
  });

  it('leaves a text row that serves a zero rate unpriced', () => {
    const row = wireRow({ pricing: { inputPerToken: '0', outputPerToken: '1500' } });

    expect(pricingFromWire(row)).toBeUndefined();
  });

  it('leaves an audio row unpriced: no price kind represents audio', () => {
    expect(pricingFromWire(wireRow({ modality: 'audio', contextLength: 0 }))).toBeUndefined();
  });
});

describe('pricingToWire', () => {
  it('serves an untiered token schedule as the two token keys alone', () => {
    const pricing = tokenPricingFixture({ input: 3450n, output: 17_250n });

    expect(pricingToWire(pricing)).toEqual({ inputPerToken: '3450', outputPerToken: '17250' });
  });

  it('serves a token schedule’s tiers as long-context rates beside its base rates', () => {
    const pricing = tokenPricingFixture({
      input: 3450n,
      output: 17_250n,
      tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
    });

    expect(pricingToWire(pricing)).toEqual({
      inputPerToken: '3450',
      outputPerToken: '17250',
      longContextRates: [
        { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
      ],
    });
  });

  it('serves both sides of a per-image price', () => {
    const pricing = perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n });

    expect(pricingToWire(pricing)).toEqual({ perImage: '40000', dearestPerImage: '90000' });
  });

  it('serves both sides of a per-second price', () => {
    const pricing = perSecondPricingFixture({
      anchor: { '720p': 100n },
      dearest: { '720p': 300n, '4k': 900n },
    });

    expect(pricingToWire(pricing)).toEqual({
      perSecondByResolution: { '720p': '100' },
      dearestPerSecondByResolution: { '720p': '300', '4k': '900' },
    });
  });

  it('round-trips a per-image price whose dearest rate is above its anchor, keeping both', () => {
    const pricing = perImagePricingFixture({ anchor: 40_000n, dearest: 90_000n });
    const row = wireRow({ modality: 'image', contextLength: 0, pricing: pricingToWire(pricing) });

    expect(pricingFromWire(row)).toEqual(pricing);
  });

  it('round-trips a per-second price whose dearest matrix is above its anchor, keeping both', () => {
    const pricing = perSecondPricingFixture({
      anchor: { '720p': 100n },
      dearest: { '720p': 300n, '4k': 900n },
    });
    const row = wireRow({ modality: 'video', contextLength: 0, pricing: pricingToWire(pricing) });

    expect(pricingFromWire(row)).toEqual(pricing);
  });

  it('round-trips an untiered token schedule through the served keys', () => {
    const pricing = tokenPricingFixture({ input: 2500n, output: 10_000n });

    expect(pricingFromWire(wireRow({ pricing: pricingToWire(pricing) }))).toEqual(pricing);
  });
});

describe('tokenPricingOf', () => {
  it('narrows a token price to itself', () => {
    const pricing = tokenPricingFixture({ input: 1n, output: 2n });

    expect(tokenPricingOf(pricing)).toBe(pricing);
  });

  it('answers nothing for a media price', () => {
    expect(tokenPricingOf(perImagePricingFixture({ anchor: 1n, dearest: 1n }))).toBeUndefined();
  });
});

describe('mediaPricingOf', () => {
  it('narrows a media price to itself', () => {
    const pricing = perImagePricingFixture({ anchor: 1n, dearest: 1n });

    expect(mediaPricingOf(pricing)).toBe(pricing);
  });

  it('answers nothing for a token price', () => {
    expect(mediaPricingOf(tokenPricingFixture({ input: 1n, output: 2n }))).toBeUndefined();
  });
});
