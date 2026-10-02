/**
 * The prompt-INDEPENDENT read of the token producer: what a payer may pick at
 * all, with no prompt in hand.
 *
 * It exists so no surface has to name the empty basis to ask that question. The
 * substitution is the producer's own (§Affordability 2, §Affordability §Scope),
 * and a caller holding the constant could pass it to the pair instead — which
 * would hand it an `admissible` set computed from a zero prompt, strictly more
 * permissive than the send gate. The last test here is that divergence, in
 * amounts, so the withholding is justified by a measurement rather than a claim.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { getAffordableOptions, getTurnOptions } from './turn-options.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.ts';

const NOW_MS = TEST_DAY_START;

const MODEL: PriceableModel = {
  modelId: modelId('vendor/a'),
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(200n) }),
  contextLength: 200_000,
  providerCap: 64_000,
  reasoning: undefined,
  releasedAtMs: 0,
};

const SELECTION: Selection = {
  answerSources: { models: [modelId('vendor/a')], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

/** A second row, unpinned, so the smart slot has a candidate to resolve onto. */
const CANDIDATE: PriceableModel = { ...MODEL, modelId: modelId('vendor/b') };

const CATALOG = { models: [MODEL, CANDIDATE], nowMs: NOW_MS };

/** A prompt long enough that carrying it costs real money at the rates above. */
const LONG_BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 400_000,
  inputChars: 100,
  attachmentBytes: 0,
};

const FUNDED: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(20_000_000n),
  heldNanoUsd: nanoUSD(5_000_000n),
  payerTier: 'paid',
  payer: 'self',
};

describe('the picker read of the token producer', () => {
  it('gives the same option set the pair grades greying from', () => {
    expect(getAffordableOptions(FUNDED, SELECTION, CATALOG).affordable).toEqual(
      getTurnOptions(FUNDED, LONG_BASIS, SELECTION, CATALOG).affordable
    );
  });

  it('gives the same smart-slot verdict the pair does', () => {
    expect(getAffordableOptions(FUNDED, SELECTION, CATALOG).smartSlot).toEqual(
      getTurnOptions(FUNDED, LONG_BASIS, SELECTION, CATALOG).smartSlot
    );
  });

  it('carries no admissibility verdict a caller could read a send gate off', () => {
    const read = getAffordableOptions(FUNDED, SELECTION, CATALOG);

    expect(Object.keys(read).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'affordable',
      'smartSlot',
    ]);
  });

  it('admits on an empty basis exactly where the real basis refuses, so defaulting it would pass a send the gate stops', () => {
    // The whole reason this read withholds admissibility rather than defaulting
    // its basis. At one funding, three answers: the payer may pick the model,
    // the send gate refuses THIS prompt, and the gate asked with the empty basis
    // says yes — which is the answer a basis-defaulting caller would show.
    const tight: FundingSnapshot = {
      spendableNanoUsd: nanoUSD(20_000_000n),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    };

    expect(getAffordableOptions(tight, SELECTION, CATALOG).affordable.sendable).toBe(true);
    expect(getTurnOptions(tight, LONG_BASIS, SELECTION, CATALOG).admissible.sendable).toBe(false);
    expect(getTurnOptions(tight, EMPTY_PROMPT_BASIS, SELECTION, CATALOG).admissible.sendable).toBe(
      true
    );
  });
});
