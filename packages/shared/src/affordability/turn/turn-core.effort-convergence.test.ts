/**
 * The composer's effort loop, pinned as a composition. The menu grades the
 * effort rungs at the turn's current pin and publishes the enabled set; the
 * shared producer lowers the user's preference onto that set; the lowered value
 * becomes the next pin, which regrades the menu. Termination rests on that
 * iteration reaching a fixed point — not on it settling in one step, which it
 * does not (see `PIN_SENSITIVE_FUNDING`).
 *
 * The two halves live in files that name each other nowhere — `turn-core.ts`
 * grades, `estimate/effort-options.ts` lowers — so a change to the grading can
 * reopen an unterminating render loop in a composer whose own tests stay green.
 * This file is the link between them.
 */

import { describe, expect, it } from 'vitest';

import { EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { effortSelectionForTurn } from '../estimate/effort-options.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { reasoningPlanModelOf } from '../model/priceable-model.ts';
import { evaluateTurn } from './turn-core.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { EffortChoice } from '../estimate/effort-options.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ReasoningEffortSelection } from '../reasoning-effort.ts';
import type { CoreInput } from './turn-core.ts';
import type { AnswerSources, PromptBasis } from './turn-types.ts';

/**
 * Offers `low`, `medium`, `high`, so funding can strand the preference partway.
 * The cap clears `high`'s own reasoning budget with the minimum answer on top,
 * so what greys a rung here is money rather than a physical output ceiling.
 */
const LADDERED: PriceableModel = {
  modelId: modelId('vendor/laddered'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
  contextLength: 1_000_000,
  providerCap: 128_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/**
 * No ladder at all: it contributes no rung to the union and resolves every
 * choice to wire silence. Beside the slot it is the shape whose pin the turn
 * honours anyway, so it is where a grading change can strand the loop.
 */
const LADDERLESS: PriceableModel = {
  ...LADDERED,
  modelId: modelId('vendor/ladderless'),
  reasoning: undefined,
};

/** Reasoning it cannot switch off: the axis's one upward resolution. */
const MANDATORY: PriceableModel = {
  ...LADDERED,
  modelId: modelId('vendor/mandatory'),
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

/** Disable-capable, so the pool can offer Min the pinned siblings cannot. */
const OPEN: PriceableModel = {
  ...LADDERED,
  modelId: modelId('vendor/open'),
  reasoning: { supportedEfforts: null },
};

const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 400,
  inputChars: 200,
  attachmentBytes: 0,
};

const NOW_MS = TEST_DAY_START;

/** The preference the loop starts from: the top of the model's ladder. */
const PREFERRED = 'high';

/**
 * One composer shape the loop runs in: who answers, and what the payer prefers.
 * The slot and ladderless axes are HERE rather than fixed, because both changed
 * what the producer answers and neither is expressible against a single pinned
 * laddered model.
 */
interface LoopCase {
  readonly pinned: readonly PriceableModel[];
  readonly smartSlot: boolean;
  readonly preferred: ReasoningEffortSelection;
  readonly catalog: readonly PriceableModel[];
}

const BASE_CASE: LoopCase = {
  pinned: [LADDERED],
  smartSlot: false,
  preferred: PREFERRED,
  catalog: [LADDERED],
};

/**
 * The union `AnswerSources` declares: an empty pinned list is legal only when
 * the slot answers, which is the one combination the case list never builds.
 */
function answerSourcesOf(loopCase: LoopCase): AnswerSources {
  const [first, ...rest] = loopCase.pinned.map((model) => model.modelId);
  if (first === undefined) return { models: [], smartSlot: true };
  return { models: [first, ...rest], smartSlot: loopCase.smartSlot };
}

function inputAt(
  loopCase: LoopCase,
  fundingNanoUsd: bigint,
  pin: EffortChoice | undefined
): CoreInput {
  return {
    fundingNanoUsd,
    basis: BASIS,
    selection: {
      answerSources: answerSourcesOf(loopCase),
      modality: 'text',
      pinned: pin === undefined ? {} : { effort: pin },
      webSearch: false,
    },
    catalog: loopCase.catalog,
    tier: 'paid',
    nowMs: NOW_MS,
  };
}

/** The graded set the menu greys from, read exactly as the composer's publisher reads it. */
function enabledAt(
  loopCase: LoopCase,
  fundingNanoUsd: bigint,
  pin: EffortChoice | undefined
): readonly EffortChoice[] {
  const dimension = evaluateTurn(
    inputAt(loopCase, fundingNanoUsd, pin)
  ).optionSet.turnDimensions.find((candidate) => candidate.dimensionId === EFFORT_DIMENSION.id);
  return (dimension?.options ?? [])
    .filter((option) => option.availability.available)
    .map((option) => option.optionId as EffortChoice);
}

/** One turn of the loop: grade at `pin`, then lower the preference onto that grading. */
function settleIn(
  loopCase: LoopCase,
  fundingNanoUsd: bigint,
  pin?: EffortChoice
): ReasoningEffortSelection | undefined {
  return effortSelectionForTurn({
    preferred: loopCase.preferred,
    models: loopCase.pinned.map((model) => reasoningPlanModelOf(model)),
    modality: 'text',
    smartSlot: loopCase.smartSlot,
    enabled: enabledAt(loopCase, fundingNanoUsd, pin),
  });
}

/** Only a canonical rung can be pinned back into the grading; `auto` leaves the axis open. */
function pinnable(settled: ReasoningEffortSelection | undefined): EffortChoice | undefined {
  return settled === undefined || settled === 'auto' ? undefined : settled;
}

/**
 * Enough turns of the loop for any real one to repeat: a step can only move to
 * another rung of the one ladder, so a run longer than the domain has rungs is
 * cycling rather than converging.
 */
const STEP_CAP = 8;

interface LoopRun {
  /** The values the loop passed through, in order; the last two repeat when it converged. */
  readonly path: readonly (ReasoningEffortSelection | undefined)[];
  readonly converged: boolean;
}

/** Iterate the loop from an open axis until the settled value repeats, or give up. */
function runLoopIn(loopCase: LoopCase, fundingNanoUsd: bigint): LoopRun {
  const path: (ReasoningEffortSelection | undefined)[] = [settleIn(loopCase, fundingNanoUsd)];
  for (let step = 0; step < STEP_CAP; step += 1) {
    const current = path.at(-1);
    const next = settleIn(loopCase, fundingNanoUsd, pinnable(current));
    path.push(next);
    if (next === current) return { path, converged: true };
  }
  return { path, converged: false };
}

function runLoop(fundingNanoUsd: bigint): LoopRun {
  return runLoopIn(BASE_CASE, fundingNanoUsd);
}

/** Spans refusal, part-funded ladders and the full ladder. */
const FUNDING_LEVELS = [
  0n,
  1000n,
  10_000n,
  100_000n,
  1_000_000n,
  10_000_000n,
  100_000_000n,
  1_000_000_000n,
  10_000_000_000n,
  100_000_000_000n,
] as const;

/**
 * The funding at which the loop's pin argument is load-bearing. An OPEN effort
 * axis buys the turn's classifier call, so grading with no pin carries a
 * `classifier-tokens` term that grading at any pin does not; here that term is
 * exactly what greys `low`. The loop therefore reads `off` first and `low` on
 * the next pass, and only the second pass repeats. Every level above spans
 * fundings where the pin changes nothing, so without this one the fixed point
 * would be a comparison of two identical no-op calls.
 */
const PIN_SENSITIVE_FUNDING = 18_500_000n;

describe('the composer effort loop converges', () => {
  it('reaches a fixed point at every funding level', () => {
    const levels = [...FUNDING_LEVELS, PIN_SENSITIVE_FUNDING];
    const cycling = levels.filter((funding) => !runLoop(funding).converged);
    expect(cycling).toEqual([]);
  });

  it('needs a second pass where the pin changes the grading', () => {
    // Teeth for the fixed point above: a loop whose step ignored its pin would
    // repeat immediately everywhere, and converging would prove nothing.
    expect(runLoop(PIN_SENSITIVE_FUNDING).path).toEqual(['off', 'low', 'low']);
  });

  it('lowers the preference at some funding level and honours it at another', () => {
    // Without both, the fixed point above holds vacuously: a sweep that never
    // lowers pins nothing about the lowering, and one that always lowers to the
    // same floor never exercises the honoured arm.
    const settled = FUNDING_LEVELS.map((funding) => runLoop(funding).path.at(-1));
    expect(settled).toContain(PREFERRED);
    expect(settled.some((value) => value !== PREFERRED)).toBe(true);
  });
});

/**
 * The same fixed point over the axes the single shape above cannot reach. Both
 * of them decide what the producer answers: the SLOT contributes the whole
 * domain (its candidates are derived at the pin), and a LADDERLESS sibling
 * contributes no rung at all — so a grading change lands on shapes where the
 * lowered value and the graded set are derived from different model sets, which
 * is exactly where a step can fail to reach a fixed point.
 */
describe('the composer effort loop converges across the slot and ladderless axes', () => {
  const CATALOG = [LADDERED, LADDERLESS, MANDATORY, OPEN] as const;

  const PINNED_SETS: readonly (readonly PriceableModel[])[] = [
    [],
    [LADDERED],
    [LADDERLESS],
    [MANDATORY],
    [OPEN],
    [LADDERED, LADDERLESS],
    [LADDERED, MANDATORY],
    [OPEN, MANDATORY],
  ];

  const PREFERENCES: readonly ReasoningEffortSelection[] = [
    'auto',
    'off',
    'lite',
    'low',
    'medium',
    'high',
    'max',
  ];

  function everyCase(): readonly LoopCase[] {
    const cases: LoopCase[] = [];
    for (const smartSlot of [false, true]) {
      for (const pinned of PINNED_SETS) {
        // A turn with no answer source at all is not a shape the composer has.
        if (pinned.length === 0 && !smartSlot) continue;
        for (const preferred of PREFERENCES) {
          cases.push({ pinned, smartSlot, preferred, catalog: CATALOG });
        }
      }
    }
    return cases;
  }

  it('reaches a fixed point for every shape at every funding level', () => {
    const levels = [...FUNDING_LEVELS, PIN_SENSITIVE_FUNDING];
    const cycling = everyCase().flatMap((loopCase) =>
      levels
        .filter((funding) => !runLoopIn(loopCase, funding).converged)
        .map(
          (funding) =>
            `${loopCase.pinned.map((model) => model.modelId).join('+') || 'none'}${
              loopCase.smartSlot ? '+slot' : ''
            }@${String(funding)}@${loopCase.preferred}`
        )
    );
    expect(cycling).toEqual([]);
  });

  it('covers both the slot and ladderless axes rather than one shape repeated', () => {
    // Teeth for the sweep above: a case list that lost its slot or ladderless
    // members would still pass it, and would pin nothing this file exists for.
    const cases = everyCase();
    expect(cases.filter((loopCase) => loopCase.smartSlot).length).toBeGreaterThan(0);
    expect(cases.filter((loopCase) => loopCase.pinned.includes(LADDERLESS)).length).toBeGreaterThan(
      0
    );
    expect(cases.length).toBe(105);
  });

  it('settles a slot turn on the preference the graded set still enables', () => {
    // The slot arm is load-bearing rather than incidental: a fully funded mixed
    // turn with a ladderless sibling honours the pin, where the pinned models
    // alone offer no rung at all.
    const settled = runLoopIn(
      { pinned: [LADDERLESS], smartSlot: true, preferred: 'high', catalog: CATALOG },
      1_000_000_000_000n
    );
    expect(settled.path.at(-1)).toBe('high');
  });
});
