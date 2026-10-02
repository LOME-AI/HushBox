/**
 * The re-partition invariant, closed end to end against a PRODUCED ceiling:
 *
 *     re-partition   cost(m, ceiling(m)) is identical for every presented option
 *                    of every open dimension
 *
 * The dimension registry's own suite pins that a split leaves the ceiling
 * untouched and that the floor is the model's largest offered budget plus a
 * minimum answer, but its ceiling was a test constant, so nothing there connected
 * the invariant to the number the producer actually prices. These pins use
 * `getTurnOptions`' own output, which is the ceiling a hold is taken against, on
 * a turn with no tool: a tool loop prices each rung at its own loop.
 *
 * Three facts make the invariant true end to end, and each is asserted:
 *
 * 1. the produced ceiling does not move with the chosen effort option;
 * 2. neither does the produced hold — effort carries no marginal money cost;
 * 3. the pool a chosen option draws from is the model's largest offered budget,
 *    and it fits inside the produced ceiling whenever the top rung is presented.
 *
 * A control shows what a ceiling priced from the chosen option would do on the
 * same fixtures, so the pins constrain something.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { dimensionSupportFor, partitionCeiling } from '../dimensions/derive.ts';
import { EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { getTurnOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { FundingSnapshot, ModelEntry, PromptBasis, Selection } from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

const LADDER: PriceableModel = {
  modelId: modelId('vendor/ladder'),
  pricing: tokenPricingFixture({ input: nanoUSD(80n), output: nanoUSD(200n) }),
  contextLength: 200_000,
  providerCap: 100_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(120_000_000n),
  heldNanoUsd: nanoUSD(0n),
  payerTier: 'paid',
  payer: 'self',
};

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 2000,
  inputChars: 200,
  attachmentBytes: 0,
};

function selectionPinnedTo(option: OptionId): Selection {
  return {
    answerSources: { models: [modelId('vendor/ladder')], smartSlot: false },
    modality: 'text',
    pinned: { effort: option },
    webSearch: false,
  };
}

function entryFor(option: OptionId): { entry: ModelEntry; holdNanoUsd: bigint | undefined } {
  const options = getTurnOptions(FUNDING, BASIS, selectionPinnedTo(option), {
    models: [LADDER],
    nowMs: NOW_MS,
  });
  const entry = options.admissible.sendable
    ? options.admissible.all.find((candidate) => candidate.modelId === 'vendor/ladder')
    : undefined;
  expect(entry).toBeDefined();
  return {
    // Narrowed by the assertion above; the fallback only satisfies the compiler.
    // The selection pins the model, so the row it looks up is a pinned one.
    entry: entry ?? {
      kind: 'pinned',
      modelId: modelId(''),
      availability: { available: true },
      ceilingTokens: 0,
      rungCeilings: [],
    },
    holdNanoUsd: options.holdNanoUsd,
  };
}

const PRESENTED_OPTIONS = dimensionSupportFor(EFFORT_DIMENSION, LADDER).options.map(
  (option) => option.optionId
);

/** The largest reasoning budget any rung {@link LADDER} offers reserves. */
const LARGEST_OFFERED_BUDGET = Math.max(
  0,
  ...PRESENTED_OPTIONS.map((option) => Number(EFFORT_DIMENSION.requirement(LADDER, option)))
);

describe('the produced ceiling is option-invariant', () => {
  it('binds a fixture presenting more than one option with distinct budgets', () => {
    expect(PRESENTED_OPTIONS.length).toBeGreaterThan(2);
    const budgets = new Set(
      PRESENTED_OPTIONS.map((option) => Number(EFFORT_DIMENSION.requirement(LADDER, option)))
    );
    expect(budgets.size).toBeGreaterThan(1);
  });

  it('prices the same ceiling whichever rung the user pins', () => {
    const ceilings = new Set(
      PRESENTED_OPTIONS.map((option) => entryFor(option).entry.ceilingTokens)
    );
    expect(ceilings.size).toBe(1);
  });

  it('places the same hold whichever rung the user pins', () => {
    const holds = new Set(PRESENTED_OPTIONS.map((option) => entryFor(option).holdNanoUsd));
    expect(holds.size).toBe(1);
  });
});

describe('the pool a chosen option draws from is the model`s largest offered budget', () => {
  it('is the top rung`s own budget', () => {
    expect(LARGEST_OFFERED_BUDGET).toBe(
      Number(EFFORT_DIMENSION.requirement(LADDER, PRESENTED_OPTIONS.at(-1) ?? 'high'))
    );
  });

  it('fits inside the produced ceiling, with a minimum answer beside it', () => {
    const { entry } = entryFor('low');
    expect(LARGEST_OFFERED_BUDGET + MINIMUM_OUTPUT_TOKENS).toBeLessThanOrEqual(entry.ceilingTokens);
  });

  it('redistributes the produced ceiling rather than enlarging it', () => {
    const { entry } = entryFor('low');
    const support = dimensionSupportFor(EFFORT_DIMENSION, LADDER);
    for (const option of PRESENTED_OPTIONS) {
      const split = partitionCeiling(EFFORT_DIMENSION, LADDER, support, {
        ceilingTokens: entry.ceilingTokens,
        chosen: option,
      });
      expect(split.ceilingTokens).toBe(entry.ceilingTokens);
      expect(split.reservedTokens + split.answerTokens).toBe(entry.ceilingTokens);
      expect(split.reservedTokens).toBeLessThanOrEqual(LARGEST_OFFERED_BUDGET);
    }
  });
});

describe('the control — a ceiling priced from the chosen option', () => {
  it('would move between rungs on this very fixture, so the pins above constrain something', () => {
    const { entry } = entryFor('low');
    const fromChosen = new Set(
      PRESENTED_OPTIONS.map(
        (option) => entry.ceilingTokens - Number(EFFORT_DIMENSION.requirement(LADDER, option))
      )
    );
    expect(fromChosen.size).toBeGreaterThan(1);
  });
});
