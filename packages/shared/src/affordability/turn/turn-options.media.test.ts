import { describe, expect, it } from 'vitest';

import { perImagePricingFixture } from '../../testing/pricing-fixture.ts';

import { getMediaTurnOptions } from './turn-options.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import type { MediaSelection } from './media-core.ts';
import type { MediaModel } from '../dimensions/media-model.ts';
import type { FundingSnapshot, PromptBasis } from './turn-types.ts';

const PER_IMAGE = 40_000_000n;
/** One generated image's stored bytes at the media byte rate: 8,000,000 × 18. */
const IMAGE_STORAGE = 144_000_000n;
/** What one image turn costs the payer: the generation and the bytes it rests in. */
const IMAGE_TURN = PER_IMAGE + IMAGE_STORAGE;

function imageModel(): MediaModel {
  return {
    modelId: modelId('vendor/imagen'),
    pricing: perImagePricingFixture({ anchor: PER_IMAGE, dearest: PER_IMAGE }),
    parameters: {
      aspectRatio: { type: 'enum', values: ['1:1'], wire: 'providerOptions' },
    },
  };
}

const SELECTION: MediaSelection = {
  modality: 'image',
  selectedIds: [modelId('vendor/imagen')],
  pinned: {},
};

/** 1,000 prompt characters — 300,000 nano of input storage. */
const BASIS: PromptBasis = { ...EMPTY_PROMPT_BASIS, inputChars: 1000 };

function funding(spendableNanoUsd: bigint, heldNanoUsd: bigint): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendableNanoUsd),
    heldNanoUsd: nanoUSD(heldNanoUsd),
    payerTier: 'paid',
    payer: 'self',
  };
}

describe('getMediaTurnOptions', () => {
  it('grades the affordable set against the hold-blind effective balance', () => {
    // Spendable alone falls one nano short; the held amount is what a live run
    // took, and greying the picker on it would move rows while a run is in
    // flight.
    const options = getMediaTurnOptions(
      funding(IMAGE_TURN - 1n, 1n),
      EMPTY_PROMPT_BASIS,
      SELECTION,
      [imageModel()]
    );

    expect(options.affordable.sendable).toBe(true);
  });

  it('grades the admissible set against spendable, so a hold blocks the send', () => {
    const options = getMediaTurnOptions(
      funding(IMAGE_TURN - 1n, 1n),
      EMPTY_PROMPT_BASIS,
      SELECTION,
      [imageModel()]
    );

    expect(options.admissible.sendable).toBe(false);
  });

  it('produces both sets from one call, so the two cannot disagree about a row', () => {
    const options = getMediaTurnOptions(funding(IMAGE_TURN, 0n), EMPTY_PROMPT_BASIS, SELECTION, [
      imageModel(),
    ]);

    expect(options.affordable.all).toEqual(options.admissible.all);
  });

  it('substitutes the empty basis into the affordable set, so no prompt greys a row', () => {
    // At exactly the turn's cost, the prompt's own storage is what the send
    // gate lacks — and greying the picker on it would move rows as the user
    // types.
    const options = getMediaTurnOptions(funding(IMAGE_TURN, 0n), BASIS, SELECTION, [imageModel()]);

    expect([options.affordable.sendable, options.admissible.sendable]).toEqual([true, false]);
  });

  it('prices the admissible set with the prompt storage the turn will be charged', () => {
    const options = getMediaTurnOptions(funding(IMAGE_TURN + 300_000n, 0n), BASIS, SELECTION, [
      imageModel(),
    ]);

    expect(options.admissible.sendable).toBe(true);
  });
});
