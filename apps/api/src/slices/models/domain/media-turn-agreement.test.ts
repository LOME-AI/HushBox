/**
 * The composer's media verdict and admission's media hold price the same turn.
 *
 * The two sides answer different questions — "may this row be picked" and "what
 * is reserved" — and they run on different sides of the wire, so they cannot be
 * one call. What they must never do is disagree about the AMOUNT: a verdict that
 * prices less than admission renders a row ungreyed and reports the turn
 * sendable, and the send then fails at the hold. That direction is the dangerous
 * one, and a missing storage leg produces exactly it.
 *
 * This is not the two-implementations-agree cross-check CODE-RULES §One
 * Implementation, Shared bans. The arithmetic itself has one home: both sides
 * reduce through the shared media core and take their stored bytes from the one
 * byte rule. What is pinned here is the COMPOSITION each side builds out of those
 * shared parts — provider generation, output storage per generating model, and
 * the prompt's own storage once per turn — which is per-side by construction and
 * is where the two last drifted.
 *
 * Both sides are fed from ONE `ModelDescriptor`, so a fixture cannot make them
 * agree by being written twice.
 */

import { describe, expect, it } from 'vitest';
import { modelId, nanoUSD } from '@hushbox/shared';
import { getMediaTurnOptions, mediaModelFromWire } from '@hushbox/shared/affordability';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { perImagePricingFixture, perSecondPricingFixture } from '@hushbox/shared/pricing-fixture';
import { buildModelsListResponse } from './catalog/list-models.js';
import { mediaTurnMinCostNanoUsd } from './pricing/estimate-run.js';
import type { MediaModel, MediaSelection, ModelDescriptor } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** The client's funding shape at an exact spendable figure; no hold outstanding. */
function fundingAt(spendableNanoUsd: bigint): Parameters<typeof getMediaTurnOptions>[0] {
  return {
    spendableNanoUsd: nanoUSD(spendableNanoUsd),
    heldNanoUsd: nanoUSD(0n),
    payerTier: 'paid',
    payer: 'self',
  };
}

/** The prompt basis both sides price the turn's input storage from. */
function basisOf(inputChars: number): Parameters<typeof getMediaTurnOptions>[1] {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: 0,
    inputChars,
    attachmentBytes: 0,
  };
}

function descriptorOf(params: {
  readonly id: string;
  readonly outputs: readonly ('image' | 'video')[];
  readonly pricing: ModelDescriptor['pricing'];
  readonly parameters: ModelDescriptor['parameters'];
}): ModelDescriptor {
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: [...params.outputs],
    parameters: params.parameters,
    behaviors: [],
    limits: {},
    pricing: params.pricing,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const IMAGE_DESCRIPTOR = descriptorOf({
  id: 'vendor/imagen',
  outputs: ['image'],
  pricing: perImagePricingFixture({ anchor: 46_000_000n, dearest: 46_000_000n }),
  parameters: {
    aspectRatio: { type: 'enum', values: ['1:1', '16:9'], wire: 'providerOptions' },
  },
});

const VIDEO_DESCRIPTOR = descriptorOf({
  id: 'vendor/veo',
  outputs: ['video'],
  pricing: perSecondPricingFixture({
    anchor: { '720p': 100_000_000n },
    dearest: { '720p': 100_000_000n },
  }),
  parameters: {
    aspectRatio: { type: 'enum', values: ['16:9'], wire: 'providerOptions' },
    resolution: { type: 'enum', values: ['720p'], wire: 'providerOptions' },
    durationSeconds: { type: 'enum', values: [4], wire: 'providerOptions' },
  },
});

/**
 * A video row that constrains resolution but declares NO duration set. This is a
 * live catalog shape, not a contrived one: the gateway reads
 * `supported_durations ?? []`, no spec is minted for an empty domain, and
 * normalization excludes a video row for a missing release date, missing token
 * pricing, an unknown unit or a missing aspect ratio — never for missing
 * durations. The turn builder calls such an axis UNCONSTRAINED, not forbidden,
 * and the request carries the composer's duration to it regardless.
 */
const UNCONSTRAINED_VIDEO_DESCRIPTOR = descriptorOf({
  id: 'vendor/anyduration',
  outputs: ['video'],
  pricing: perSecondPricingFixture({
    anchor: { '720p': 100_000_000n },
    dearest: { '720p': 100_000_000n },
  }),
  parameters: {
    aspectRatio: { type: 'enum', values: ['16:9'], wire: 'providerOptions' },
    resolution: { type: 'enum', values: ['720p'], wire: 'providerOptions' },
  },
});

/** The browser's media model: the descriptor served as the catalog serves it, then read back. */
function mediaModelOf(descriptor: ModelDescriptor): MediaModel {
  const [served] = buildModelsListResponse([descriptor], TEST_DAY_START).response.models;
  const projected = served === undefined ? undefined : mediaModelFromWire(served);
  if (projected === undefined)
    throw new Error(`fixture ${descriptor.id} is not per-unit priceable`);
  return projected;
}

const IMAGE_SELECTION: MediaSelection = {
  modality: 'image',
  selectedIds: [modelId(IMAGE_DESCRIPTOR.id)],
  pinned: { aspectRatio: '1:1' },
};

const VIDEO_SELECTION: MediaSelection = {
  modality: 'video',
  selectedIds: [modelId(VIDEO_DESCRIPTOR.id)],
  pinned: { aspectRatio: '16:9', resolution: '720p', durationSeconds: '4' },
};

const UNCONSTRAINED_VIDEO_SELECTION: MediaSelection = {
  modality: 'video',
  selectedIds: [modelId(UNCONSTRAINED_VIDEO_DESCRIPTOR.id)],
  // The composer pins a duration whatever the model declares — the request will
  // carry it, so the verdict has to price it.
  pinned: { aspectRatio: '16:9', resolution: '720p', durationSeconds: '4' },
};

/** 1,000 prompt characters: the input-storage leg, non-zero so it discriminates. */
const PROMPT_CHARS = 1000;

/**
 * The send gate's own flip point, found by asking it at one funding figure and
 * at one nano less. A single `sendable === true` assertion is satisfied by any
 * verdict that prices the turn at or below the figure, including one that prices
 * nothing at all; the pair fixes the amount exactly.
 */
function sendGateFlipsAt(
  selection: MediaSelection,
  catalog: readonly MediaModel[],
  figureNanoUsd: bigint,
  inputChars: number
): { readonly atFigure: boolean; readonly oneNanoShort: boolean } {
  const basis = basisOf(inputChars);
  return {
    atFigure: getMediaTurnOptions(fundingAt(figureNanoUsd), basis, selection, catalog).admissible
      .sendable,
    oneNanoShort: getMediaTurnOptions(fundingAt(figureNanoUsd - 1n), basis, selection, catalog)
      .admissible.sendable,
  };
}

describe('media verdict ⇄ admission ceiling', () => {
  it('sends an image turn exactly at the figure admission holds for it', () => {
    const admission = mediaTurnMinCostNanoUsd(
      [IMAGE_DESCRIPTOR],
      {},
      { inputChars: PROMPT_CHARS }
    )._unsafeUnwrap();

    expect(
      sendGateFlipsAt(IMAGE_SELECTION, [mediaModelOf(IMAGE_DESCRIPTOR)], admission, PROMPT_CHARS)
    ).toEqual({ atFigure: true, oneNanoShort: false });
  });

  it('sends a video turn exactly at the figure admission holds for it', () => {
    const admission = mediaTurnMinCostNanoUsd(
      [VIDEO_DESCRIPTOR],
      { resolution: '720p', durationSeconds: 4 },
      { inputChars: PROMPT_CHARS }
    )._unsafeUnwrap();

    expect(
      sendGateFlipsAt(VIDEO_SELECTION, [mediaModelOf(VIDEO_DESCRIPTOR)], admission, PROMPT_CHARS)
    ).toEqual({ atFigure: true, oneNanoShort: false });
  });

  it('sends a video turn whose model declares no durations at the pinned duration', () => {
    // The model constrains resolution and nothing else, so the duration axis is
    // unconstrained: it runs whatever the request asks for, and admission prices
    // the four seconds the composer pinned on BOTH legs.
    const admission = mediaTurnMinCostNanoUsd(
      [UNCONSTRAINED_VIDEO_DESCRIPTOR],
      { resolution: '720p', durationSeconds: 4 },
      { inputChars: PROMPT_CHARS }
    )._unsafeUnwrap();

    expect(
      sendGateFlipsAt(
        UNCONSTRAINED_VIDEO_SELECTION,
        [mediaModelOf(UNCONSTRAINED_VIDEO_DESCRIPTOR)],
        admission,
        PROMPT_CHARS
      )
    ).toEqual({ atFigure: true, oneNanoShort: false });
  });

  it('holds the composed amounts the two sides agree on, so a drift names its own leg', () => {
    // provider 46,000,000 + storage 8,000,000 bytes × 18 = 144,000,000
    // + prompt 1,000 chars × 300 = 300,000.
    expect(
      mediaTurnMinCostNanoUsd([IMAGE_DESCRIPTOR], {}, { inputChars: PROMPT_CHARS })._unsafeUnwrap()
    ).toBe(190_300_000n);

    // provider 4 × 100,000,000 + storage 4 × 5,000,000 bytes × 18 = 360,000,000
    // + the same prompt storage.
    expect(
      mediaTurnMinCostNanoUsd(
        [VIDEO_DESCRIPTOR],
        { resolution: '720p', durationSeconds: 4 },
        { inputChars: PROMPT_CHARS }
      )._unsafeUnwrap()
    ).toBe(760_300_000n);
  });
});
