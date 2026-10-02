import { describe, expect, it, vi } from 'vitest';

import { cheapestPresentedOption, dimensionSupportFor, reserveContribution } from './derive.ts';
import {
  ASPECT_RATIO_DIMENSION,
  DURATION_DIMENSION,
  MEDIA_DIMENSIONS,
  MEDIA_REFERENCE_UNITS,
  RESOLUTION_DIMENSION,
  mediaDimensionFor,
} from './media.ts';
import { openDimension } from './registry.ts';
import { DimensionRegistrationError } from './registry.ts';
import { MEDIA_DIMENSION_IDS } from './types.ts';
import { modelId } from '../model/model-id.ts';
import { perImagePricingFixture, perSecondPricingFixture } from '../../testing/pricing-fixture.ts';
import type { MediaModel } from './media-model.ts';
import type { CostCurve } from '../price/curve.ts';

function videoModel(overrides: Partial<MediaModel> = {}): MediaModel {
  return {
    modelId: modelId('vendor/veo'),
    pricing: perSecondPricingFixture({
      anchor: { '720p': 150_000_000n, '1080p': 400_000_000n },
      dearest: { '720p': 150_000_000n, '1080p': 400_000_000n },
    }),
    parameters: {
      resolution: { type: 'enum', values: ['720p', '1080p'], wire: 'providerOptions' },
      aspectRatio: { type: 'enum', values: ['16:9', '9:16'], wire: 'providerOptions' },
      durationSeconds: { type: 'enum', values: [4, 8], wire: 'providerOptions' },
    },
    ...overrides,
  };
}

function imageModel(overrides: Partial<MediaModel> = {}): MediaModel {
  return {
    modelId: modelId('vendor/imagen'),
    pricing: perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n }),
    parameters: {
      aspectRatio: { type: 'enum', values: ['1:1', '16:9', '9:16'], wire: 'providerOptions' },
    },
    ...overrides,
  };
}

describe('MEDIA_DIMENSIONS', () => {
  const alphabetical = (a: string, b: string): number => a.localeCompare(b);

  it('holds exactly one entry per media dimension id', () => {
    expect(Object.keys(MEDIA_DIMENSIONS).toSorted(alphabetical)).toEqual(
      [...MEDIA_DIMENSION_IDS].toSorted(alphabetical)
    );
  });

  it('is frozen, so a consumer cannot register a dimension by assignment', () => {
    expect(Object.isFrozen(MEDIA_DIMENSIONS)).toBe(true);
  });

  it('reads an entry by id', () => {
    expect(mediaDimensionFor('resolution')).toBe(RESOLUTION_DIMENSION);
  });

  it('declares no global option domain, so the catalog stays the only one', () => {
    // `param.values` absent is the model-dimension precedent: media option sets
    // are per model, so a literal domain here would be the second hand-maintained
    // domain this registry exists to remove.
    for (const id of MEDIA_DIMENSION_IDS) {
      expect(mediaDimensionFor(id).param.values).toBeUndefined();
    }
  });
});

describe('the aspect-ratio dimension', () => {
  it('declares itself zero cost — no resource, free cost class', () => {
    expect(ASPECT_RATIO_DIMENSION.resource).toBe('none');
    expect(ASPECT_RATIO_DIMENSION.costClass).toBe('free');
  });

  it('skips affordability entirely: an open aspect ratio contributes nothing', () => {
    const model = imageModel();
    const support = dimensionSupportFor(ASPECT_RATIO_DIMENSION, model);
    expect(support.options.map((option) => option.optionId)).toEqual(['1:1', '16:9', '9:16']);
    expect(reserveContribution(ASPECT_RATIO_DIMENSION, model, support)).toEqual({ kind: 'none' });
  });

  it('offers only what the model itself declares, never a global list', () => {
    const narrow = imageModel({
      parameters: { aspectRatio: { type: 'enum', values: ['1:1'], wire: 'providerOptions' } },
    });
    expect(dimensionSupportFor(ASPECT_RATIO_DIMENSION, narrow).options).toEqual([
      { optionId: '1:1', label: '1:1' },
    ]);
  });

  it('offers nothing when the model declares no aspect-ratio domain', () => {
    const bare = imageModel({ parameters: {} });
    expect(dimensionSupportFor(ASPECT_RATIO_DIMENSION, bare).options).toEqual([]);
  });

  it('wires the option under the catalog parameter name', () => {
    expect(ASPECT_RATIO_DIMENSION.wire(imageModel(), '16:9')).toEqual({ aspectRatio: '16:9' });
  });

  it('requires nothing in any resource, and refuses a ratio the model has not declared', () => {
    expect(ASPECT_RATIO_DIMENSION.requirement(imageModel(), '1:1')).toBe(0);
    expect(() => ASPECT_RATIO_DIMENSION.requirement(imageModel(), '21:9')).toThrow(RangeError);
  });
});

describe('the resolution dimension', () => {
  it('declares money out of spendable, added to the turn, ordered and enumerable', () => {
    expect(RESOLUTION_DIMENSION.resource).toBe('money');
    expect(RESOLUTION_DIMENSION.costClass).toBe('additive');
    expect(RESOLUTION_DIMENSION.ordered).toBe(true);
    expect(RESOLUTION_DIMENSION.enumerable).toBe(true);
  });

  it('requires the per-unit reference cost of one second at that resolution', () => {
    expect(RESOLUTION_DIMENSION.requirement(videoModel(), '720p')).toBe(
      150_000_000n * BigInt(MEDIA_REFERENCE_UNITS)
    );
    expect(RESOLUTION_DIMENSION.requirement(videoModel(), '1080p')).toBe(
      400_000_000n * BigInt(MEDIA_REFERENCE_UNITS)
    );
  });

  it('requires the flat per-image rate on a model priced per image, not per second', () => {
    const model = imageModel({
      parameters: {
        resolution: { type: 'enum', values: ['1k', '2k'], wire: 'providerOptions' },
      },
    });
    expect(RESOLUTION_DIMENSION.requirement(model, '2k')).toBe(
      40_000_000n * BigInt(MEDIA_REFERENCE_UNITS)
    );
  });

  it('requires the dearest per-second rate, the side a hold reserves, not the anchor', () => {
    const model = videoModel({
      pricing: perSecondPricingFixture({
        anchor: { '720p': 150_000_000n, '1080p': 400_000_000n },
        dearest: { '720p': 300_000_000n, '1080p': 800_000_000n },
      }),
    });
    expect(RESOLUTION_DIMENSION.requirement(model, '1080p')).toBe(
      800_000_000n * BigInt(MEDIA_REFERENCE_UNITS)
    );
  });

  it('requires the dearest per-image rate on a model priced per image', () => {
    const model = imageModel({
      pricing: perImagePricingFixture({ anchor: 40_000_000n, dearest: 90_000_000n }),
      parameters: {
        resolution: { type: 'enum', values: ['1k', '2k'], wire: 'providerOptions' },
      },
    });
    expect(RESOLUTION_DIMENSION.requirement(model, '2k')).toBe(
      90_000_000n * BigInt(MEDIA_REFERENCE_UNITS)
    );
  });

  it('refuses a resolution only the dearest side prices, which the anchor cannot show', () => {
    const model = videoModel({
      pricing: perSecondPricingFixture({
        anchor: { '720p': 150_000_000n },
        dearest: { '720p': 300_000_000n, '1080p': 800_000_000n },
      }),
    });
    expect(() => RESOLUTION_DIMENSION.requirement(model, '1080p')).toThrow(RangeError);
  });

  it('refuses a resolution the model does not price, rather than reporting a zero', () => {
    expect(() => RESOLUTION_DIMENSION.requirement(videoModel(), '4k')).toThrow(RangeError);
  });

  it('offers only the declared resolutions the model states a rate for', () => {
    const model = videoModel({
      parameters: {
        resolution: { type: 'enum', values: ['720p', '4k'], wire: 'providerOptions' },
      },
    });

    expect(dimensionSupportFor(RESOLUTION_DIMENSION, model).options).toEqual([
      { optionId: '720p', label: '720p' },
    ]);
  });

  it('wires the option under the catalog parameter name, and refuses an unpriced one', () => {
    expect(RESOLUTION_DIMENSION.wire(videoModel(), '1080p')).toEqual({ resolution: '1080p' });
    expect(() => RESOLUTION_DIMENSION.wire(videoModel(), '4k')).toThrow(RangeError);
  });

  it('reserves the worst presented option when it is open', () => {
    const model = videoModel();
    const support = dimensionSupportFor(RESOLUTION_DIMENSION, model);
    expect(reserveContribution(RESOLUTION_DIMENSION, model, support)).toEqual({
      kind: 'money',
      nanoUsd: 400_000_000n * BigInt(MEDIA_REFERENCE_UNITS),
    });
  });
});

describe('the duration dimension', () => {
  it('scales the per-unit reference cost rather than adding to it', () => {
    expect(DURATION_DIMENSION.costClass).toBe('multiplicative');
    expect(DURATION_DIMENSION.deliversAtHoldCeiling).toBe(false);
  });

  it('is continuous, so it may be pinned but never opened to a classifier', () => {
    expect(DURATION_DIMENSION.enumerable).toBe(false);
    expect(() => openDimension(DURATION_DIMENSION)).toThrow(DimensionRegistrationError);
  });

  it('requires the requested second count, which scales the per-second cost', () => {
    expect(DURATION_DIMENSION.requirement(videoModel(), '8')).toBe(8);
  });

  it('refuses a duration the model does not declare', () => {
    expect(() => DURATION_DIMENSION.requirement(videoModel(), '5')).toThrow(RangeError);
  });

  it('offers the catalog set, and nothing at all when the catalog declares none', () => {
    expect(dimensionSupportFor(DURATION_DIMENSION, videoModel()).options).toEqual([
      { optionId: '4', label: '4s' },
      { optionId: '8', label: '8s' },
    ]);
    expect(dimensionSupportFor(DURATION_DIMENSION, imageModel()).options).toEqual([]);
  });

  it('ranks its own options, whose requirement is a factor and not an amount', () => {
    // A multiplicative dimension declares the resource it SCALES, so its
    // requirement is a bare factor: the fallback ranking has to compare it the
    // same way `reserveContribution` reads it — cost class ahead of resource.
    const model = videoModel();
    expect(
      cheapestPresentedOption(
        DURATION_DIMENSION,
        model,
        dimensionSupportFor(DURATION_DIMENSION, model)
      )
    ).toBe('4');
  });

  it('wires the second count as a number, and refuses an undeclared duration', () => {
    expect(DURATION_DIMENSION.wire(videoModel(), '4')).toEqual({ durationSeconds: 4 });
    expect(() => DURATION_DIMENSION.wire(videoModel(), '5')).toThrow(RangeError);
  });

  it('scales the delivered bound by the worst presented option', () => {
    const model = videoModel();
    const support = dimensionSupportFor(DURATION_DIMENSION, model);
    expect(reserveContribution(DURATION_DIMENSION, model, support)).toEqual({
      kind: 'ceilingMultiplier',
      factor: 8,
    });
  });
});

describe('mediaUnitsCostNanoUsd', () => {
  /** A curve whose one regime prices a media call per output token, which no media call has. */
  function curveCarrying(item: CostCurve['regimes'][number]['manifest'][number]): CostCurve {
    return {
      cap: Number.MAX_SAFE_INTEGER,
      regimes: [{ fromOutputTokens: 0, manifest: [item], stepTiers: [] }],
    };
  }

  // The price core's media curve is substituted for these cases because
  // construction is the only thing that makes the refusal unreachable: the curve
  // emits its one item with a `fixedNano`, while the shared line-item type also
  // permits an item priced only per output token.
  it('refuses a line item carrying no fixed amount rather than pricing it at zero', async () => {
    vi.resetModules();
    vi.doMock('../price/curve.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../price/curve.ts')>()),
      mediaCallCurve: () =>
        curveCarrying({ label: 'media-generation', variableOutputRateNano: 1n, kind: 'provider' }),
    }));
    try {
      const { mediaUnitsCostNanoUsd } = await import('./media.ts');
      expect(() => mediaUnitsCostNanoUsd(imageModel(), { units: 1 })).toThrow(RangeError);
    } finally {
      vi.doUnmock('../price/curve.ts');
      vi.resetModules();
    }
  });

  it('refuses a line item that also prices per output token rather than dropping that leg', async () => {
    // Reading the fixed leg alone answers 5n here and drops the per-token one.
    // A media call is priced per unit with no output count to charge such a leg
    // against, so the total refuses rather than under-pricing the call by it.
    vi.resetModules();
    vi.doMock('../price/curve.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../price/curve.ts')>()),
      mediaCallCurve: () =>
        curveCarrying({
          label: 'media-generation',
          fixedNano: 5n,
          variableOutputRateNano: 1n,
          kind: 'provider',
        }),
    }));
    try {
      const { mediaUnitsCostNanoUsd } = await import('./media.ts');
      expect(() => mediaUnitsCostNanoUsd(imageModel(), { units: 1 })).toThrow(RangeError);
    } finally {
      vi.doUnmock('../price/curve.ts');
      vi.resetModules();
    }
  });
});
