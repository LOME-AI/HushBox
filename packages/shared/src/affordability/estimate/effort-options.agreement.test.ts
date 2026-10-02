/**
 * Picker and send, asked about the same model at the same moment.
 *
 * A picker row is graded on the model's cheapest reachable rung, so a reasoning
 * model whose completion cap cannot fit the pinned rung is still offered. What
 * makes that offer honest is this module: the composer lowers the preference
 * onto the rungs the produced set enables, so clicking the row sends at the
 * highest rung the cap can fit rather than at the pin the row could not reach.
 *
 * The two halves are written in files that name each other nowhere —
 * `turn/turn-core.ts` grades, this module lowers — so the agreement is a
 * composition, and only a test that runs both can hold it. Termination of the
 * loop is `turn/turn-core.effort-convergence.test.ts`; what is asserted here is
 * WHERE it settles, and that the settled turn actually runs. That file's
 * fixtures are funded out of their rungs; these are capped out of them, which is
 * the corner a cheapest-corner picker row opens and the one no money clears.
 *
 * "Runs" here means the set the SERVER gates a send on — `admissible`, spendable
 * money against the composed prompt — and not the picker's own `affordable`
 * set. `admissible ⊆ affordable` (`turn/turn-options.ts`), so the two are
 * separate evaluations and an affordable-side pass is the strictly weaker
 * claim: it would say the picker agrees with itself.
 */

import { describe, expect, it } from 'vitest';

import { EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { reasoningPlanModelOf } from '../model/priceable-model.ts';
import { getAffordableOptions, getTurnOptions } from '../turn/turn-options.ts';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from './reasoning-plan.ts';
import { effortSelectionForTurn } from './effort-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ReasoningEffortSelection } from '../reasoning-effort.ts';
import type {
  CandidateModelEntry,
  FundingSnapshot,
  OptionSet,
  PromptBasis,
  Selection,
} from '../turn/turn-types.ts';
import type { EffortChoice } from './effort-options.ts';

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
 * balance. Medium is the highest rung that still fits beside one.
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
 * A cap below the cheapest rung's budget: every engaged rung is out of reach and
 * only reasoning off leaves room for the minimum answer.
 */
const TINY: PriceableModel = {
  ...RATES,
  modelId: modelId('vendor/tiny'),
  providerCap: 5000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** No ladder at all: the axis is silent on it whatever the turn settles on. */
const PLAIN: PriceableModel = {
  ...RATES,
  modelId: modelId('vendor/plain'),
  providerCap: 64_000,
  reasoning: undefined,
};

const CATALOG = [CAPPED, ROOMY, TINY, PLAIN];

/** $10,000 spendable: money is never the constraint in this file. */
const RICH: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(10_000_000_000_000n),
  heldNanoUsd: nanoUSD(0n),
  payerTier: 'paid',
  payer: 'self',
};

/** The preference the payer stored and the picker rows are graded under. */
const PREFERRED = 'high';

/**
 * A composed prompt for the send gate to grade against — the picker has none,
 * the server always does. Tiny beside the pool's context length, so the only
 * thing left that can refuse a turn here is the completion cap.
 */
const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 400,
  inputChars: 200,
  attachmentBytes: 0,
};

function candidateRows(set: OptionSet): readonly CandidateModelEntry[] {
  return set.all.filter((entry): entry is CandidateModelEntry => entry.kind === 'candidate');
}

/**
 * The union `AnswerSources` declares: an empty pinned list is legal only when
 * the slot answers, which is the picker's own shape before a row is chosen.
 */
function selectionAt(pinned: readonly PriceableModel[], pin: EffortChoice | undefined): Selection {
  const [first, ...rest] = pinned.map((model) => model.modelId);
  return {
    answerSources:
      first === undefined
        ? { models: [], smartSlot: true }
        : { models: [first, ...rest], smartSlot: false },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch: false,
  };
}

/** What the picker grades its rows and its effort menu from. */
function affordableAt(pinned: readonly PriceableModel[], pin: EffortChoice | undefined): OptionSet {
  return getAffordableOptions(RICH, selectionAt(pinned, pin), { models: CATALOG, nowMs: NOW_MS })
    .affordable;
}

/**
 * What the send is gated on: the server reads `getTurnOptions(...).admissible`
 * and refuses an unsendable one
 * (`apps/api/src/slices/models/domain/smart-model/candidates.ts`). It is a
 * second evaluation of the core over different money and a different basis, so
 * only asking it can pin the picker's offer against the send.
 */
function admissibleAt(pinned: readonly PriceableModel[], pin: EffortChoice | undefined): OptionSet {
  return getTurnOptions(RICH, BASIS, selectionAt(pinned, pin), {
    models: CATALOG,
    nowMs: NOW_MS,
  }).admissible;
}

/** The graded set the menu greys from, read exactly as the composer's publisher reads it. */
function enabledAt(
  pinned: readonly PriceableModel[],
  pin: EffortChoice | undefined
): readonly EffortChoice[] {
  const dimension = affordableAt(pinned, pin).turnDimensions.find(
    (candidate) => candidate.dimensionId === EFFORT_DIMENSION.id
  );
  return (dimension?.options ?? [])
    .filter((option) => option.availability.available)
    .map((option) => option.optionId as EffortChoice);
}

/** Only a canonical rung can be pinned back into the grading; `auto` leaves the axis open. */
function pinnable(settled: ReasoningEffortSelection | undefined): EffortChoice | undefined {
  return settled === undefined || settled === 'auto' ? undefined : settled;
}

/**
 * The value the send carries once the composer's loop has stopped moving: grade
 * at the current pin, lower the preference onto that grading, repeat. The step
 * cap is the loop's own — a run longer than the domain has rungs is cycling, and
 * cycling is the convergence file's failure to report, not this one's.
 */
function settled(pinned: readonly PriceableModel[]): ReasoningEffortSelection | undefined {
  let current: ReasoningEffortSelection | undefined;
  for (let step = 0; step < 8; step += 1) {
    const next = effortSelectionForTurn({
      preferred: PREFERRED,
      models: pinned.map((model) => reasoningPlanModelOf(model)),
      modality: 'text',
      smartSlot: false,
      enabled: enabledAt(pinned, pinnable(current)),
    });
    if (step > 0 && next === current) return next;
    current = next;
  }
  return current;
}

describe('a model the picker offers under a pin its cap cannot reach', () => {
  it('is offered on the strength of a rung the pin is above', () => {
    const row = candidateRows(affordableAt([], PREFERRED)).find(
      (entry) => entry.modelId === CAPPED.modelId
    );
    expect(row?.activation.add).toStrictEqual({ available: true });
  });

  it('is a row the pin alone still refuses, which is what the send has to answer for', () => {
    const row = candidateRows(affordableAt([], PREFERRED)).find(
      (entry) => entry.modelId === CAPPED.modelId
    );
    expect(row?.availability).toStrictEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });

  it('sends at the highest rung below the pin that its cap can fit', () => {
    expect(settled([CAPPED])).toBe('medium');
  });

  it('sends a turn the send gate admits, rather than one it refuses', () => {
    expect(admissibleAt([CAPPED], pinnable(settled([CAPPED]))).sendable).toBe(true);
  });

  it('sends at reasoning off when no engaged rung fits its cap', () => {
    expect(settled([TINY])).toBe('off');
  });
});

describe('a model whose cap fits the pin', () => {
  it('sends at the pin itself', () => {
    expect(settled([ROOMY])).toBe(PREFERRED);
  });

  it("drops to its sibling's reach when one stands beside it", () => {
    expect(settled([ROOMY, CAPPED])).toBe('medium');
  });
});

describe('every row the picker offers', () => {
  it('yields a turn the send gate admits once it is the selection', () => {
    const offered = candidateRows(affordableAt([], PREFERRED))
      .filter((entry) => entry.activation.add.available)
      .map((entry) => CATALOG.find((model) => model.modelId === entry.modelId));
    const refused = offered
      .filter((model): model is PriceableModel => model !== undefined)
      .filter((model) => !admissibleAt([model], pinnable(settled([model]))).sendable)
      .map((model) => model.modelId);
    expect(refused).toEqual([]);
  });

  it('is more than the rows the pin alone would have offered', () => {
    const rows = candidateRows(affordableAt([], PREFERRED));
    const selectable = rows.filter((entry) => entry.activation.add.available).length;
    const availableAtPin = rows.filter((entry) => entry.availability.available).length;
    expect(selectable).toBeGreaterThan(availableAtPin);
  });
});
