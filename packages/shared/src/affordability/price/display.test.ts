import { describe, expect, it } from 'vitest';

import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import {
  anchorBaseRatesNanoUsd,
  combinedAnchorRateNanoUsd,
  modelPriceDisplay,
  smartPoolRange,
} from './display.ts';
import type { Model } from '../../schemas/api/models.ts';

const tiered = tokenPricingFixture({
  input: 3450n,
  output: 17_250n,
  tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
});

function wireRow(overrides: Partial<Model>): Model {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    provider: 'vendor',
    modality: 'text',
    contextLength: 1_000_000,
    pricing: {},
    description: 'a model',
    supportedParameters: [],
    ...overrides,
  };
}

const TIERED_ROW = wireRow({
  pricing: {
    inputPerToken: '3450',
    outputPerToken: '17250',
    longContextRates: [
      { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
    ],
  },
});

describe('anchorBaseRatesNanoUsd', () => {
  it('reads the anchor’s base rates, never a long-context tier’s', () => {
    expect(anchorBaseRatesNanoUsd(tiered)).toEqual({ input: 3450n, output: 17_250n });
  });
});

describe('combinedAnchorRateNanoUsd', () => {
  it('adds the anchor’s base input and output rates', () => {
    expect(combinedAnchorRateNanoUsd(tiered)).toBe(20_700n);
  });
});

describe('modelPriceDisplay of a text row', () => {
  it('heads with the anchor’s base rates per 1k tokens', () => {
    const display = modelPriceDisplay(TIERED_ROW);

    expect([display.inputPer1k, display.outputPer1k]).toEqual(['$0.00345', '$0.01725']);
  });

  it('lists each long-context rate per 1k tokens above its threshold', () => {
    expect(modelPriceDisplay(TIERED_ROW).longContext).toEqual([
      { abovePromptTokens: 200_000, inputPer1k: '$0.0069', outputPer1k: '$0.025875' },
    ]);
  });

  it('lists no long-context rate for an untiered row', () => {
    const row = wireRow({ pricing: { inputPerToken: '3450', outputPerToken: '17250' } });

    expect(modelPriceDisplay(row).longContext).toEqual([]);
  });

  it('sorts by the anchor’s base input and output rates added', () => {
    expect(modelPriceDisplay(TIERED_ROW).sortKeyNanoUsd).toBe(20_700n);
  });

  it('carries the anchor’s base input rate per token, never a long-context rate', () => {
    expect(modelPriceDisplay(TIERED_ROW).inputNanoUsd).toBe(3450n);
  });

  it('carries the anchor’s base output rate per token, never a long-context rate', () => {
    expect(modelPriceDisplay(TIERED_ROW).outputNanoUsd).toBe(17_250n);
  });

  it('flags a row whose base rates reach $0.10 per 1k tokens together as expensive', () => {
    const row = wireRow({ pricing: { inputPerToken: '30000', outputPerToken: '70000' } });

    expect(modelPriceDisplay(row).expensive).toBe(true);
  });

  it('leaves a row one nano per token under that threshold unflagged', () => {
    const row = wireRow({ pricing: { inputPerToken: '30000', outputPerToken: '69999' } });

    expect(modelPriceDisplay(row).expensive).toBe(false);
  });

  it('judges the threshold on base rates even when a long-context rate reaches it', () => {
    const row = wireRow({
      pricing: {
        inputPerToken: '3450',
        outputPerToken: '17250',
        longContextRates: [
          { abovePromptTokens: 200_000, inputPerToken: '30000', outputPerToken: '70000' },
        ],
      },
    });

    expect(modelPriceDisplay(row).expensive).toBe(false);
  });
});

describe('modelPriceDisplay of a row with no price', () => {
  const unpriced = modelPriceDisplay(wireRow({ pricing: { inputPerToken: '3450' } }));

  it('shows no rate', () => {
    expect([unpriced.inputPer1k, unpriced.outputPer1k]).toEqual([undefined, undefined]);
  });

  it('carries no rate per token', () => {
    expect([unpriced.inputNanoUsd, unpriced.outputNanoUsd]).toEqual([undefined, undefined]);
  });

  it('has no sort key, so it is never the cheapest', () => {
    expect(unpriced.sortKeyNanoUsd).toBeUndefined();
  });

  it('is not flagged expensive', () => {
    expect(unpriced.expensive).toBe(false);
  });
});

describe('modelPriceDisplay of a media row', () => {
  const imageRow = wireRow({
    modality: 'image',
    contextLength: 0,
    pricing: { perImage: '40000000', dearestPerImage: '90000000' },
  });

  it('shows an image row’s anchor per image', () => {
    expect(modelPriceDisplay(imageRow).perImageNanoUsd).toBe(40_000_000n);
  });

  it('sorts an image row by its anchor per image', () => {
    expect(modelPriceDisplay(imageRow).sortKeyNanoUsd).toBe(40_000_000n);
  });

  it('shows a video row’s anchor per second at each resolution', () => {
    const display = modelPriceDisplay(
      wireRow({
        modality: 'video',
        contextLength: 0,
        pricing: {
          perSecondByResolution: { '720p': '200', '1080p': '100' },
          dearestPerSecondByResolution: { '720p': '600', '1080p': '300' },
        },
      })
    );

    expect(display.perSecondNanoUsd).toEqual({ '720p': 200n, '1080p': 100n });
  });

  it('sorts a video row by its cheapest resolution’s anchor', () => {
    const display = modelPriceDisplay(
      wireRow({
        modality: 'video',
        contextLength: 0,
        pricing: {
          perSecondByResolution: { '720p': '200', '1080p': '100' },
          dearestPerSecondByResolution: { '720p': '600', '1080p': '300' },
        },
      })
    );

    expect(display.sortKeyNanoUsd).toBe(100n);
  });

  it('gives an audio row no price and no sort key', () => {
    const display = modelPriceDisplay(wireRow({ modality: 'audio', contextLength: 0 }));

    expect([display.perImageNanoUsd, display.perSecondNanoUsd, display.sortKeyNanoUsd]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('modelPriceDisplay of the Smart Model row', () => {
  const smartRow = wireRow({
    isSmartModel: true,
    pricing: { inputPerToken: '1150', outputPerToken: '2300' },
    minPricing: { inputPerToken: '1150', outputPerToken: '2300' },
    maxPricing: { inputPerToken: '2300', outputPerToken: '4600' },
  });

  it('shows the pool’s input range per 1k tokens', () => {
    expect(modelPriceDisplay(smartRow).inputRangePer1k).toBe('$0.00115 – $0.0023 / 1k');
  });

  it('shows the pool’s output range per 1k tokens', () => {
    expect(modelPriceDisplay(smartRow).outputRangePer1k).toBe('$0.0023 – $0.0046 / 1k');
  });

  it('shows no range for a leg whose upper bound is not served', () => {
    const row = wireRow({ ...smartRow, maxPricing: { outputPerToken: '4600' } });

    expect(modelPriceDisplay(row).inputRangePer1k).toBeUndefined();
  });

  it('shows no range on a row that serves none', () => {
    expect(modelPriceDisplay(TIERED_ROW).inputRangePer1k).toBeUndefined();
  });

  it('carries the pool’s input range per token', () => {
    expect(modelPriceDisplay(smartRow).inputRangeNanoUsd).toEqual({ min: 1150n, max: 2300n });
  });

  it('carries the pool’s output range per token', () => {
    expect(modelPriceDisplay(smartRow).outputRangeNanoUsd).toEqual({ min: 2300n, max: 4600n });
  });

  it('carries no range for a leg whose upper bound is not served', () => {
    const row = wireRow({ ...smartRow, maxPricing: { outputPerToken: '4600' } });

    expect(modelPriceDisplay(row).inputRangeNanoUsd).toBeUndefined();
  });
});

describe('smartPoolRange', () => {
  const cheap = tokenPricingFixture({ input: 100n, output: 900n });
  const dear = tokenPricingFixture({
    input: 400n,
    output: 500n,
    tiers: [{ abovePromptTokens: 200_000, input: 9000n, output: 9000n }],
  });

  it('takes each base rate’s minimum across the pool, leg by leg', () => {
    expect(smartPoolRange([cheap, dear]).minPricing).toEqual({
      inputPerToken: '100',
      outputPerToken: '500',
    });
  });

  it('takes each base rate’s maximum across the pool, never a long-context rate', () => {
    expect(smartPoolRange([cheap, dear]).maxPricing).toEqual({
      inputPerToken: '400',
      outputPerToken: '900',
    });
  });

  it('refuses an empty pool rather than publishing a free rate', () => {
    expect(() => smartPoolRange([])).toThrow(RangeError);
  });
});
