/**
 * What a PICKER row is greyed by: whether clicking the model yields a turn that
 * can run at all, which `docs/BILLING.md` §Predicates grades on the resolved
 * cheapest corner `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS` — "never on an
 * unreachable zero", and never on the rung the payer happens to have pinned.
 *
 * The pin is a question about the EFFORT axis, and the effort axis answers it:
 * a rung a model cannot reach is greyed on that model's own option list. Grading
 * the MODEL on the pin instead refused every reasoning model whose completion
 * cap sits at or below the rung's budget — a refusal no balance clears, because
 * `B` clamps to the cap and the minimum answer no longer fits beside it.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '../estimate/reasoning-plan.ts';
import { getAffordableOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type {
  AddAvailability,
  Availability,
  CandidateModelEntry,
  FundingSnapshot,
  OptionSet,
  Selection,
} from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/** Identical rates across the pool, so no member is priced out as an outlier. */
const RATES = {
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(200n) }),
  contextLength: 200_000,
  releasedAtMs: 0,
} as const;

/**
 * A completion cap exactly at the High rung's budget: `B` clamps to the cap, so
 * the minimum answer has nowhere left to go and High is unreachable at any
 * balance. Every rung below it fits, and so does reasoning-off.
 */
const CAPPED: PriceableModel = {
  ...RATES,
  modelId: modelId('vendor/capped'),
  providerCap: REASONING_BUDGET_TOKENS_BY_EFFORT.high,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** The same ladder with room to spare: High fits beside a minimum answer. */
const ROOMY: PriceableModel = {
  ...RATES,
  modelId: modelId('vendor/roomy'),
  providerCap: 64_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/**
 * One mandatory rung at a cap that rung cannot fit: `e_min(m)` IS High here, so
 * no effort level the model offers is feasible and nothing makes it selectable.
 */
const MANDATORY_CAPPED: PriceableModel = {
  ...RATES,
  modelId: modelId('vendor/mandatory-capped'),
  providerCap: REASONING_BUDGET_TOKENS_BY_EFFORT.high,
  reasoning: { supportedEfforts: ['high'], mandatory: true },
};

const CATALOG = [CAPPED, ROOMY, MANDATORY_CAPPED];

/** $10,000 spendable: money is never the constraint in this file. */
const RICH_FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(10_000_000_000_000n),
  heldNanoUsd: nanoUSD(0n),
  payerTier: 'paid',
  payer: 'self',
};

/** The fresh-conversation selection: the Smart Model alone, nothing pinned. */
function selectionOf(effort?: string): Selection {
  return {
    answerSources: { models: [], smartSlot: true },
    modality: 'text',
    pinned: effort === undefined ? {} : { effort },
    webSearch: false,
  };
}

function affordableSetOf(catalog: readonly PriceableModel[], effort?: string): OptionSet {
  return getAffordableOptions(RICH_FUNDING, selectionOf(effort), { models: catalog, nowMs: NOW_MS })
    .affordable;
}

function candidateOf(set: OptionSet, id: string): CandidateModelEntry {
  const entry = set.all.find((row) => row.modelId === id);
  if (entry?.kind !== 'candidate') throw new Error(`no candidate row for ${id}`);
  return entry;
}

function addArmOf(id: string, effort?: string): AddAvailability {
  return candidateOf(affordableSetOf(CATALOG, effort), id).activation.add;
}

function rungOf(entry: CandidateModelEntry, optionId: string): Availability | undefined {
  return entry.dimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability;
}

describe('a picker row under an effort pin its own cap cannot reach', () => {
  it('offers the model for selection, since a rung it offers is feasible', () => {
    expect(addArmOf('vendor/capped', 'high')).toStrictEqual({ available: true });
  });

  it('still withholds it from the classifier, which binds the pin it was given', () => {
    expect(
      candidateOf(affordableSetOf(CATALOG, 'high'), 'vendor/capped').availability
    ).toStrictEqual({ available: false, reason: 'model_output_cap_too_low' });
  });

  it('refuses selection of a model whose every offered rung is out of reach', () => {
    expect(addArmOf('vendor/mandatory-capped', 'high')).toStrictEqual({
      available: false,
      reason: 'model_output_cap_too_low',
      causedBy: 'model',
    });
  });
});

describe('the effort axis keeps answering for the rungs', () => {
  it('greys the rung the cap cannot fit on the row that cannot fit it', () => {
    const row = candidateOf(affordableSetOf(CATALOG, 'high'), 'vendor/capped');

    expect(rungOf(row, 'high')).toStrictEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });

  it('leaves the rungs below it available on that same row', () => {
    const row = candidateOf(affordableSetOf(CATALOG, 'high'), 'vendor/capped');

    expect(rungOf(row, 'low')).toStrictEqual({ available: true });
  });

  it('greys the turn-level rung when no answer source can reach it', () => {
    const options = affordableSetOf([CAPPED], 'high')
      .turnDimensions.find((dimension) => dimension.dimensionId === 'effort')
      ?.options.find((option) => option.optionId === 'high');

    expect(options?.availability).toStrictEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });
});

describe('an open effort axis grades exactly as it did', () => {
  it('offers every model whose cheapest corner fits', () => {
    expect([addArmOf('vendor/capped'), addArmOf('vendor/roomy')]).toStrictEqual([
      { available: true },
      { available: true },
    ]);
  });

  it('refuses the model whose cheapest corner does not', () => {
    expect(addArmOf('vendor/mandatory-capped')).toStrictEqual({
      available: false,
      reason: 'model_output_cap_too_low',
      causedBy: 'model',
    });
  });
});
