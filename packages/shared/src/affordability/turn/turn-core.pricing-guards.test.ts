/**
 * The classifier reserve, the one producer whose output the turn price folds in
 * whole. A zero from it would price the turn BELOW what it will spend, so it
 * prices only a token schedule and prices every leg of the call.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { classifierWorstCaseNanoUsd } from '../estimate/smart-model-affordability.ts';
import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.ts';
import { evaluateTurn } from './turn-core.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { perImagePricingFixture, tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { CoreInput } from './turn-core.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { Selection } from './turn-types.ts';

const CHEAP: PriceableModel = {
  modelId: modelId('vendor/cheap'),
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(200n) }),
  contextLength: 100_000,
  providerCap: 32_000,
  releasedAtMs: 0,
  reasoning: undefined,
};

const PLAIN: PriceableModel = {
  modelId: modelId('vendor/plain'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

const NOW_MS = TEST_DAY_START;

function inputOf(selection: Selection, catalog: readonly PriceableModel[]): CoreInput {
  return {
    fundingNanoUsd: 1_000_000_000n,
    basis: EMPTY_PROMPT_BASIS,
    selection,
    catalog,
    tier: 'paid',
    nowMs: NOW_MS,
  };
}

const SMART_SLOT: Selection = {
  answerSources: { models: [], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

describe('the classifier reserve', () => {
  it('refuses a classifier the estimator cannot price rather than reserving nothing for it', () => {
    const media = perImagePricingFixture({ anchor: 100n, dearest: 100n });
    // @ts-expect-error -- the reserve prices a token schedule only; a price with
    // no per-token rate has no classifier call to price.
    expect(() => classifierWorstCaseNanoUsd({ pricing: media }, [])).toThrow();
  });

  it('prices the reserve’s per-output-token leg at the output cap rather than as free', () => {
    // Held at their ceilings, the output rates 200 and 201 are 250 and 252:
    // two nano apart on every output token up to the cap.
    const dearerOutput = {
      pricing: tokenPricingFixture({ input: 100n, output: 201n }),
    };
    expect(
      classifierWorstCaseNanoUsd(dearerOutput, []) - classifierWorstCaseNanoUsd(CHEAP, [])
    ).toBe(BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 2n);
  });

  it('holds the reserve in the smart slot’s turn price', () => {
    const turn = evaluateTurn(inputOf(SMART_SLOT, [CHEAP, PLAIN]));
    const reserve = classifierWorstCaseNanoUsd(
      CHEAP,
      [CHEAP, PLAIN].map(({ modelId: id }) => ({ id }))
    );
    expect(turn.lineItems.find((item) => item.label === 'classifier-tokens')?.fixedNano).toBe(
      reserve
    );
  });
});
