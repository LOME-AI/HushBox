import { describe, expect, it } from 'vitest';

import { perImagePricingFixture, perSecondPricingFixture } from '../../testing/pricing-fixture.ts';

import {
  maxMediaCallCostNanoUsd,
  mediaOutlierModelIds,
  medianMaxMediaCallCostNanoUsd,
} from './turn-arithmetic.ts';
import { modelId } from '../model/model-id.ts';
import type { MediaModel } from '../dimensions/media-model.ts';

function videoModel(id: string, ratePerSecond: bigint): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perSecondPricingFixture({
      anchor: { '720p': ratePerSecond },
      dearest: { '720p': ratePerSecond },
    }),
    parameters: {
      resolution: { type: 'enum', values: ['720p'], wire: 'providerOptions' },
      durationSeconds: { type: 'enum', values: [4, 8], wire: 'providerOptions' },
    },
  };
}

function imageModel(id: string, perImage: bigint): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perImagePricingFixture({ anchor: perImage, dearest: perImage }),
    parameters: {},
  };
}

const ONE_IMAGE = { units: 1 } as const;
const EIGHT_SECONDS_720P = { units: 8, dimensionKey: '720p' } as const;

describe('maxMediaCallCostNanoUsd', () => {
  it('prices a per-second model at the reference quantity — N seconds at a resolution', () => {
    expect(
      maxMediaCallCostNanoUsd(videoModel('vendor/veo', 150_000_000n), EIGHT_SECONDS_720P)
    ).toBe(1_200_000_000n);
  });

  it('prices a per-image model at the reference quantity — one image', () => {
    expect(maxMediaCallCostNanoUsd(imageModel('vendor/imagen', 40_000_000n), ONE_IMAGE)).toBe(
      40_000_000n
    );
  });

  it('applies no token-shaped bound: the reference quantity is the only bound', () => {
    // A per-unit rate has neither a context headroom nor a completion cap to
    // clamp against, so the quantity scales the cost linearly. A token-shaped
    // bound leaking in here would silently cap a long generation's cost.
    const model = videoModel('vendor/veo', 150_000_000n);
    expect(maxMediaCallCostNanoUsd(model, { units: 600, dimensionKey: '720p' })).toBe(
      600n * 150_000_000n
    );
  });

  it('reports no cost for a resolution the model does not price, rather than a zero', () => {
    const cost = maxMediaCallCostNanoUsd(videoModel('vendor/veo', 150_000_000n), {
      units: 4,
      dimensionKey: '4k',
    });

    expect(cost).toBeUndefined();
    expect(cost).not.toBe(0n);
  });
});

describe('medianMaxMediaCallCostNanoUsd', () => {
  it('takes the median over a media pool, so media models produce a finite sample', () => {
    const pool = [
      videoModel('vendor/a', 100_000_000n),
      videoModel('vendor/b', 200_000_000n),
      videoModel('vendor/c', 300_000_000n),
    ];
    expect(medianMaxMediaCallCostNanoUsd(pool, EIGHT_SECONDS_720P)).toBe(8n * 200_000_000n);
  });

  it('has no median over an empty pool', () => {
    expect(medianMaxMediaCallCostNanoUsd([], EIGHT_SECONDS_720P)).toBeUndefined();
  });

  it('leaves a row the quantity does not price out of the sample rather than sampling a zero', () => {
    // Sampled at zero the set is three and its middle member is the cheaper
    // priced row, so the assertion would read 8n * 100_000_000n instead.
    const pool = [
      videoModel('vendor/a', 100_000_000n),
      videoModel('vendor/b', 300_000_000n),
      {
        ...videoModel('vendor/unpriced', 1n),
        pricing: perSecondPricingFixture({ anchor: { '1080p': 1n }, dearest: { '1080p': 1n } }),
      },
    ];

    expect(medianMaxMediaCallCostNanoUsd(pool, EIGHT_SECONDS_720P)).toBe(8n * 300_000_000n);
  });
});

describe('mediaOutlierModelIds', () => {
  it('excludes a media row costing more than the multiple of the media median', () => {
    const pool = [
      videoModel('vendor/a', 100_000_000n),
      videoModel('vendor/b', 100_000_000n),
      videoModel('vendor/extreme', 5_000_000_000n),
    ];
    expect([...mediaOutlierModelIds(pool, EIGHT_SECONDS_720P)]).toEqual(['vendor/extreme']);
  });

  it('excludes nothing when nothing in the pool prices', () => {
    expect(mediaOutlierModelIds([], EIGHT_SECONDS_720P).size).toBe(0);
  });
});
