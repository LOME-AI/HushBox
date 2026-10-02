import { describe, expect, it } from 'vitest';

import { perSecondPricingFixture } from '../../testing/pricing-fixture.ts';
import { evaluateMediaTurn } from './media-core.ts';
import { modelId } from '../model/model-id.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import type { MediaSelection } from './media-core.ts';
import type { MediaModel } from '../dimensions/media-model.ts';

/**
 * A video row's declared resolution domain and its `perSecondByResolution` keys
 * are separate members of the wire contract, so a row CAN carry a resolution its
 * own matrix does not price. These pin what the money layer does with one: it
 * refuses, and it never indexes a matrix by a key the matrix does not hold.
 */

const SECOND_720P = 100_000_000n;
const AMPLE_FUNDING = 10n ** 13n;

/** Every axis pinned to a value the fixtures below declare. */
const VIDEO_PINS = { aspectRatio: '16:9', resolution: '720p', durationSeconds: '4' } as const;

function videoModel(
  id: string,
  declaredResolutions: readonly string[],
  pricedResolutions: Readonly<Record<string, bigint>>
): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perSecondPricingFixture({ anchor: pricedResolutions, dearest: pricedResolutions }),
    parameters: {
      aspectRatio: { type: 'enum', values: ['16:9'], wire: 'providerOptions' },
      ...(declaredResolutions.length === 0
        ? {}
        : {
            resolution: {
              type: 'enum' as const,
              values: [...declaredResolutions],
              wire: 'providerOptions' as const,
            },
          }),
      durationSeconds: { type: 'enum', values: [4], wire: 'providerOptions' },
    },
  };
}

function turnOf(
  catalog: readonly MediaModel[],
  pinned: MediaSelection['pinned'] = VIDEO_PINS
): ReturnType<typeof evaluateMediaTurn> {
  return evaluateMediaTurn({
    fundingNanoUsd: AMPLE_FUNDING,
    basis: EMPTY_PROMPT_BASIS,
    catalog,
    selection: {
      modality: 'video',
      selectedIds: catalog.map((model) => model.modelId),
      pinned,
    },
  });
}

function resolutionOptions(
  set: ReturnType<typeof evaluateMediaTurn>
): readonly { readonly optionId: string }[] | undefined {
  return set.turnDimensions.find((dimension) => dimension.dimensionId === 'resolution')?.options;
}

describe('evaluateMediaTurn on a resolution the price matrix does not carry', () => {
  it('presents only the resolutions the model can be priced at', () => {
    const set = turnOf([videoModel('vendor/veo', ['720p', '4k'], { '720p': SECOND_720P })]);

    expect(resolutionOptions(set)?.map((option) => option.optionId)).toEqual(['720p']);
  });

  it('refuses a turn pinned to a declared resolution the matrix cannot price', () => {
    const set = turnOf([videoModel('vendor/veo', ['720p', '4k'], { '720p': SECOND_720P })], {
      ...VIDEO_PINS,
      resolution: '4k',
    });

    expect(set.sendable ? undefined : set.refusal).toBe('option_not_offered');
  });

  it('greys a model whose every declared resolution is unpriced', () => {
    const set = turnOf([videoModel('vendor/veo', ['4k'], { '720p': SECOND_720P })]);

    expect(set.all.find((entry) => entry.modelId === 'vendor/veo')?.availability).toEqual({
      available: false,
      reason: 'model_not_priceable',
    });
  });

  it('greys a model carrying a price matrix with no resolution domain to index it by', () => {
    const set = turnOf([videoModel('vendor/veo', [], { '720p': SECOND_720P })]);

    expect(set.all.find((entry) => entry.modelId === 'vendor/veo')?.availability).toEqual({
      available: false,
      reason: 'model_not_priceable',
    });
  });
});
