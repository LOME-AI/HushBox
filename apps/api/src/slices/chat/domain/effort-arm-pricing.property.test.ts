/**
 * The two shapes an effort selection on ONE pinned model can compile to, priced
 * against each other by the canonical admission estimator:
 *
 * - the CLASSIFYING arm — a single-candidate `smartModel` slot with the effort
 *   axis open, preceded by the turn's own classifier call;
 * - the PINNED arm — one plain `modelCall` at a rung the payer named.
 *
 * They are different node shapes rather than one definition minus a term, so
 * "they differ solely by the classifier reserve" is a claim about produced prices
 * and is measured here rather than reasoned about: both arms are stamped at ONE
 * shared answer cap and the gap is compared against the shared reserve producer,
 * never against a figure re-derived in this file.
 *
 * The money consequence follows from the gap's SIGN, not its size: the fit is
 * monotone in the fixed cost it prices against, so a non-negative reserve coming
 * off can only grow the admissible cap set. Both regimes are exercised — a
 * physical-bound fit returns the same cap on both arms (the reserve comes back
 * as a smaller hold), a money-bound one returns a strictly larger cap on the arm
 * that no longer carries it.
 *
 * A control on each property keeps the reserve in place and shows the reading
 * move, so neither pin is measuring an instrument that answers the same whatever
 * it is handed.
 */

import { describe, expect, it } from 'vitest';

import { isTurnClassifierNode, nanoUSD } from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { classifierWorstCaseNanoUsd } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';

import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { createEstimateRun, snapshotResolver } from '../../models/index.js';
import { CHAT_TURN_HOOKS } from './constants.js';
import { compileAutoEffortTurn } from './smart-model/turn.js';
import { compileSingleTurn, fitAnswerCapToCeiling } from './turn/definition.js';
import type { TurnBudget } from './turn/definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type {
  CanonicalReasoningEffort,
  ModelDescriptor,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NanoUSD } from '@hushbox/shared';

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function descriptorOf(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 400_000 },
    pricing: tokenPricingFixture({ input: 2n, output: 3n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

/** The classifier engine: the cheapest pool member, so every arm below picks it. */
const ENGINE = descriptorOf('engine-model', {
  pricing: tokenPricingFixture({ input: 1n, output: 1n }),
});

const LADDER = descriptorOf('ladder-model', { reasoning: { supportedEfforts: null } });
const PRICEY = descriptorOf('pricey-model', {
  reasoning: { supportedEfforts: null },
  pricing: tokenPricingFixture({ input: 40_000n, output: 200_000n }),
});

const ANSWER_MODELS: readonly ModelDescriptor[] = [LADDER, PRICEY];
const CATALOG: readonly ModelDescriptor[] = [ENGINE, ...ANSWER_MODELS];
const resolver = snapshotResolver(CATALOG);
const estimate = createEstimateTotal(resolver);

/** Funds no cap in this file can exhaust — the fit then returns its own guess. */
const UNBOUNDED = nanoUSD(10_000_000_000_000n);

/**
 * The reserve an arm holds for its classifier. An effort-only classifier prompts
 * NO model list, which is the basis the shared producer prices, so the figure is
 * read from that producer rather than restated here. An unpriceable engine is a
 * broken fixture, not a zero reserve.
 */
function reserveOf(engine: ModelDescriptor): bigint {
  if (engine.pricing.kind !== 'tokens') {
    throw new Error(`fixture classifier '${engine.id}' has no token price`);
  }
  return classifierWorstCaseNanoUsd({ pricing: engine.pricing }, []);
}

const RESERVE = reserveOf(ENGINE);

function budgetOf(promptCharacterCount: number, spendableNanoUsd: bigint): TurnBudget {
  return {
    promptCharacterCount,
    inputCharacterCount: promptCharacterCount,
    funding: { kind: 'purchased', spendableNanoUsd: nanoUSD(spendableNanoUsd) },
  };
}

function classifyingArm(
  model: string,
  budget: TurnBudget,
  catalog: readonly ModelDescriptor[] = CATALOG
): WorkflowDefinition {
  const build = compileAutoEffortTurn(catalog, model, {
    budget: budget,
    hooks: CHAT_TURN_HOOKS,
    now: new Date(TEST_DAY_START),
  })._unsafeUnwrap();
  if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
  return build.definition;
}

function pinnedArm(
  model: string,
  budget: TurnBudget,
  effort: CanonicalReasoningEffort,
  resolve: ModelPricingResolver = resolver
): WorkflowDefinition {
  return compileSingleTurn(resolve, model, {
    budget,
    hooks: CHAT_TURN_HOOKS,
    reasoningEffort: effort,
  })._unsafeUnwrap();
}

function capOf(params: Readonly<Record<string, unknown>>): readonly number[] {
  const declared = params['maxOutputTokens'];
  return typeof declared === 'number' ? [declared] : [];
}

/**
 * The ANSWER node's stamped completion cap — the total output ceiling the turn is
 * admitted for, and the quantity the two arms are compared at. The classifier's
 * own node carries a cap of its own and is not one of these, which is the same
 * distinction the production fit draws.
 */
function stampedCap(definition: WorkflowDefinition): number {
  const caps = definition.nodes.flatMap((node) => {
    if (node.type === 'smartModel') return capOf(node.params);
    if (node.type !== 'modelCall' || isTurnClassifierNode(node, definition.nodes)) return [];
    return capOf(node.params);
  });
  const [only] = caps;
  if (caps.length !== 1 || only === undefined) {
    throw new Error(`expected exactly one answer cap, found ${String(caps.length)}`);
  }
  return only;
}

/**
 * The arm re-stamped to carry exactly `cap` output tokens on its answer node, via
 * the production fit at funds it cannot exhaust. The searched quantity is the
 * answer headroom H and a pinned rung adds its constant budget B on top, so the
 * caller passes the headroom that lands on the shared cap — and the landing is
 * asserted rather than assumed, which is what makes "at the same cap" a fact.
 */
function atCap(
  definition: WorkflowDefinition,
  headroom: number,
  cap: number,
  resolve: ModelPricingResolver = resolver
): WorkflowDefinition {
  const fit = fitAnswerCapToCeiling(definition, resolve, headroom, UNBOUNDED);
  expect(fit.withinFunds).toBe(true);
  expect(stampedCap(fit.definition)).toBe(cap);
  return fit.definition;
}

function priced(definition: WorkflowDefinition): bigint {
  return estimate(definition)._unsafeUnwrap();
}

interface PremisePoint {
  readonly label: string;
  readonly model: string;
  readonly promptCharacterCount: number;
  readonly effort: CanonicalReasoningEffort;
  readonly cap: number;
}

const EFFORTS: readonly CanonicalReasoningEffort[] = ['lite', 'high'];
const PROMPT_CHARS: readonly number[] = [400, 40_000];
const CAPS: readonly number[] = [
  REASONING_BUDGET_TOKENS_BY_EFFORT.high + MINIMUM_OUTPUT_TOKENS,
  REASONING_BUDGET_TOKENS_BY_EFFORT.high + 20_000,
];

const PREMISE_GRID: readonly PremisePoint[] = ANSWER_MODELS.flatMap((descriptor) =>
  PROMPT_CHARS.flatMap((promptCharacterCount) =>
    EFFORTS.flatMap((effort) =>
      CAPS.map((cap) => ({
        label: `${descriptor.id} chars=${String(promptCharacterCount)} ${effort} cap=${String(cap)}`,
        model: descriptor.id,
        promptCharacterCount,
        effort,
        cap,
      }))
    )
  )
);

/** One grid point's two arms, each stamped at that point's shared answer cap. */
function armsAt(point: PremisePoint): {
  readonly classifying: WorkflowDefinition;
  readonly pinned: WorkflowDefinition;
} {
  const budget = budgetOf(point.promptCharacterCount, 10_000_000_000_000n);
  const reasoningBudget = REASONING_BUDGET_TOKENS_BY_EFFORT[point.effort];
  return {
    classifying: atCap(classifyingArm(point.model, budget), point.cap, point.cap),
    pinned: atCap(
      pinnedArm(point.model, budget, point.effort),
      point.cap - reasoningBudget,
      point.cap
    ),
  };
}

describe('the classifying arm prices the pinned arm plus its classifier reserve', () => {
  it('differs by exactly the reserve at every point of the grid', () => {
    const gaps = PREMISE_GRID.map((point) => {
      const { classifying, pinned } = armsAt(point);
      return `${point.label} :: ${String(priced(classifying) - priced(pinned))}`;
    });
    expect(gaps).toEqual(PREMISE_GRID.map((point) => `${point.label} :: ${String(RESERVE)}`));
  });

  it('binds a grid whose two arms really are the two shapes', () => {
    // The gap is a whole extra call rather than the difference between two
    // answer legs, which is only meaningful if the shapes differ in that call.
    const [point] = PREMISE_GRID;
    if (point === undefined) throw new Error('the grid is empty');
    const { classifying, pinned } = armsAt(point);
    expect(classifying.nodes.map((node) => node.type)).toEqual([
      'modelCall',
      'fanIn',
      'smartModel',
    ]);
    expect(pinned.nodes.map((node) => node.type)).toEqual(['modelCall']);
    expect(RESERVE).toBeGreaterThan(0n);
  });

  it('control: an arm that does not drop the reserve reads a different gap', () => {
    // The mutant keeps the reserve on the pinned side by adding it back. The two
    // readings must not agree: were the estimator blind to the classifier node
    // the real gap would already be zero, and both arms would read alike.
    const real = PREMISE_GRID.map((point) => {
      const { classifying, pinned } = armsAt(point);
      return priced(classifying) - priced(pinned);
    });
    const mutant = PREMISE_GRID.map((point) => {
      const { classifying, pinned } = armsAt(point);
      return priced(classifying) - (priced(pinned) + RESERVE);
    });
    expect(new Set(real)).toEqual(new Set([RESERVE]));
    expect(new Set(mutant)).toEqual(new Set([0n]));
    expect(real).not.toEqual(mutant);
  });

  it('narrows to the classifier node`s own ceiling when the engine cannot hold the reserve', () => {
    // The equality above is the general case and not an identity: the reserve
    // prices the classifier's full truncated-context budget, while the node is
    // priced against the engine's own window. An engine whose window is smaller
    // than that budget is charged its window, so the gap comes out BELOW the
    // reserve — the over-reserving direction, and still strictly positive, which
    // is the only property the cap monotonicity below rests on.
    const narrow = descriptorOf('narrow-engine', {
      pricing: tokenPricingFixture({ input: 1n, output: 1n }),
      limits: { contextLength: 1000 },
    });
    const catalog = [narrow, LADDER];
    const narrowResolver = snapshotResolver(catalog);
    const narrowEstimate = createEstimateTotal(narrowResolver);
    const budget = budgetOf(400, 10_000_000_000_000n);
    const cap = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 20_000;
    const classifying = atCap(classifyingArm(LADDER.id, budget, catalog), cap, cap, narrowResolver);
    const pinned = atCap(
      pinnedArm(LADDER.id, budget, 'high', narrowResolver),
      cap - REASONING_BUDGET_TOKENS_BY_EFFORT.high,
      cap,
      narrowResolver
    );
    const gap =
      narrowEstimate(classifying)._unsafeUnwrap() - narrowEstimate(pinned)._unsafeUnwrap();
    expect(gap).toBeGreaterThan(0n);
    expect(gap).toBeLessThan(reserveOf(narrow));
  });
});

/**
 * The shared physical guess both arms are fitted under, so the only difference
 * between them is the fixed cost the estimator prices — never a wider bound on
 * one side. It is well inside every fixture model's own room, so no per-node
 * clamp interferes.
 */
const ROOM = 60_000;
const B_HIGH = REASONING_BUDGET_TOKENS_BY_EFFORT.high;

/**
 * A cap inside the band where the money bound bites: above the pinned arm's own
 * floor (its rung's budget plus a minimum answer, below which the fit reports it
 * cannot fund one) and below the shared physical ceiling.
 */
const MONEY_BOUND_CAP = 40_000;

/**
 * Both arms are SHAPED against funds that bind nothing and then fitted against
 * the funding level under test, so the only thing moving across the sweep is the
 * money the fit prices against.
 */
const SHAPING = budgetOf(400, 10_000_000_000_000n);

/**
 * One arm's fit at one funding level: the total answer cap it buys, and whether
 * the estimator prices that cap inside the funds at all. The flag travels with
 * the cap because a cap the fit could not fund is a REFUSAL the caller's own gate
 * raises — reading it as a cap the payer received is the mistake that would make
 * the comparison below say the opposite of the truth.
 */
interface ArmFit {
  readonly capTokens: number;
  readonly withinFunds: boolean;
}

function fitAt(definition: WorkflowDefinition, headroom: number, spendable: bigint): ArmFit {
  const fit = fitAnswerCapToCeiling(definition, resolver, headroom, nanoUSD(spendable));
  return { capTokens: stampedCap(fit.definition), withinFunds: fit.withinFunds };
}

function classifyingFit(spendable: bigint): ArmFit {
  return fitAt(classifyingArm(LADDER.id, SHAPING), ROOM, spendable);
}

/**
 * The pinned arm's fit. `reserveCharged` models the payer who is still charged
 * the reserve — it is taken out of the funds instead of out of the definition,
 * which is the same constraint, and is the control the growth below is measured
 * against.
 */
function pinnedFit(spendable: bigint, reserveCharged = false): ArmFit {
  return fitAt(
    pinnedArm(LADDER.id, SHAPING, 'high'),
    ROOM - B_HIGH,
    reserveCharged ? spendable - RESERVE : spendable
  );
}

/** Every cap the sweep asks the affordability question about. */
const PROBE_CAPS: readonly number[] = [
  B_HIGH + MINIMUM_OUTPUT_TOKENS,
  B_HIGH + 5000,
  MONEY_BOUND_CAP,
  50_000,
  ROOM,
];

/** One cap's price on each arm, both stamped to carry exactly that cap. */
function pricesAt(cap: number): { readonly classifying: bigint; readonly pinned: bigint } {
  return {
    classifying: priced(atCap(classifyingArm(LADDER.id, SHAPING), cap, cap)),
    pinned: priced(atCap(pinnedArm(LADDER.id, SHAPING, 'high'), cap - B_HIGH, cap)),
  };
}

/**
 * Funding levels the sweep prices against. The exact price of a cap on the
 * pinned arm is included as a WITNESS: a grid of round numbers can miss a band
 * only a reserve wide, and a witness derived from the produced price cannot.
 */
const WITNESS = pricesAt(MONEY_BOUND_CAP).pinned;
const SPENDABLE: readonly bigint[] = [1_000_000n, 5_000_000n, 10_000_000n, WITNESS, 100_000_000n];

describe('dropping the reserve only ever grows the admissible cap set', () => {
  it('affords under the pinned arm every cap it affords under the classifying one', () => {
    // The set statement, which is the whole money side: the two arms price one
    // shared cap a fixed reserve apart, so funds that cover it on the classifying
    // arm cover it on the pinned one. Asserted over produced prices rather than
    // argued from the gap.
    const regressions = SPENDABLE.flatMap((spendable) =>
      PROBE_CAPS.flatMap((cap) => {
        const prices = pricesAt(cap);
        return prices.classifying <= spendable && prices.pinned > spendable
          ? [`spendable=${String(spendable)} cap=${String(cap)}`]
          : [];
      })
    );
    expect(regressions).toEqual([]);
  });

  it('grows the set strictly somewhere, so the clause above is not vacuous', () => {
    const gained = SPENDABLE.flatMap((spendable) =>
      PROBE_CAPS.filter((cap) => {
        const prices = pricesAt(cap);
        return prices.pinned <= spendable && prices.classifying > spendable;
      })
    );
    expect(gained.length).toBeGreaterThan(0);
  });
});

describe('the fit never returns a smaller cap for a smaller fixed cost', () => {
  it('returns at least the classifying arm`s cap wherever both arms can fund one', () => {
    const shrunk = SPENDABLE.flatMap((spendable) => {
      const before = classifyingFit(spendable);
      const after = pinnedFit(spendable);
      if (!before.withinFunds || !after.withinFunds) return [];
      return after.capTokens < before.capTokens ? [String(spendable)] : [];
    });
    expect(shrunk).toEqual([]);
  });

  it('reaches the money-bound regime, where the cap strictly grows', () => {
    const grown = SPENDABLE.filter((spendable) => {
      const before = classifyingFit(spendable);
      const after = pinnedFit(spendable);
      return before.withinFunds && after.withinFunds && after.capTokens > before.capTokens;
    });
    expect(grown.length).toBeGreaterThan(0);
  });

  it('reaches the physical regime, where the reserve comes back as a smaller hold', () => {
    // The premise correction this pin exists to keep honest: once the physical
    // ceiling already fits inside the funds the fit early-returns it on BOTH
    // arms, so the freed reserve is returned as a smaller hold rather than
    // re-spent on answer headroom. Both regimes are real; neither is the story.
    const before = classifyingFit(100_000_000n);
    const after = pinnedFit(100_000_000n);
    expect([before.capTokens, after.capTokens]).toEqual([ROOM, ROOM]);
  });

  it('control: a payer still charged the reserve gains nothing', () => {
    // The mutant does not drop the reserve — it only moves it from the
    // definition to the funds, which is the same constraint. It must land where
    // the classifying arm lands while the real arm does not, or the growth above
    // is being read off something other than the reserve.
    const comparable = SPENDABLE.filter(
      (spendable) => classifyingFit(spendable).withinFunds && pinnedFit(spendable).withinFunds
    );
    expect(comparable.length).toBeGreaterThan(0);
    const mutant = comparable.map(
      (spendable) => pinnedFit(spendable, true).capTokens - classifyingFit(spendable).capTokens
    );
    const real = comparable.map(
      (spendable) => pinnedFit(spendable).capTokens - classifyingFit(spendable).capTokens
    );
    expect(new Set(mutant)).toEqual(new Set([0]));
    expect(real).not.toEqual(mutant);
    expect(real.some((delta) => delta > 0)).toBe(true);
  });
});
