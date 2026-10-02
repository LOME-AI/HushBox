/**
 * The multi-model `auto` turn's classifier: the graph it compiles to, the
 * amounts admission holds for it, and the prompt it is actually sent.
 *
 * Every assertion here is about the definition a REQUEST compiles — the
 * production `compileMultiModelTurnOutcome` — rather than about a reassembled twin, so
 * a sizing or shape change cannot pass here and fail in a run.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODES,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  REASONING_EFFORT_LABELS,
  TURN_DECISION_REDUCER,
  getTurnOptions,
  isTurnClassifierNode,
  modelId,
  nanoUSD,
  promptBasisFromTotal,
  textTag,
} from '@hushbox/shared';
import { inputTokensOf } from '@hushbox/shared/affordability';
import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  decisionDomainInput,
  reducerCode,
} from '../../../workflows/index.js';
import { createModelCallExecution } from '../../../workflows/domain/nodes/model-call-execution.js';
import { createValueStore } from '../../../workflows/domain/engine/value-store.js';
import { ok } from '../../../../lib/result/index.js';
import { createEstimateRun, pickEffortClassifier } from '../../../models/index.js';
import { CHAT_CLASSIFIER_INPUT, CHAT_DECISION_DOMAIN_INPUT, CHAT_TURN_INPUT } from '../index.js';
import { CHAT_TURN_HOOKS } from '../constants.js';
import { compileAutoEffortTurn } from '../smart-model/turn.js';
import { compileMultiModelTurnOutcome, turnInputs } from './definition.js';
import { decisionDomainFor, presentedEffortOptions, turnClassifies } from './classifier.js';
import { smartModelPool } from '../../../models/domain/smart-model/candidates.js';
import type { MultiModelTurnBuild, MultiModelTurnOutcome, TurnBudget } from './definition.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type {
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  ModelReasoning,
  Node,
  WorkflowDefinition,
} from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const TURN_PROMPT = 'what is the airspeed velocity of an unladen swallow?';

function descriptorOf(id: string, reasoning?: ModelReasoning, rate = 2000n): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 128_000, maxOutputTokens: 16_000 },
    pricing: tokenPricingFixture({ input: rate, output: rate * 4n }),
    ...(reasoning === undefined ? {} : { reasoning }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

/** A model with no reasoning metadata at all — it offers no effort choice. */
const UNSET_REASONING: ModelReasoning | undefined = undefined;

/** An open-ladder reasoner: offers the full canonical ladder plus Min. */
const LADDER: ModelReasoning = { supportedEfforts: null };

/** The cheapest model in the catalog — by construction, the classifier engine. */
const ENGINE = descriptorOf('cheap/engine', UNSET_REASONING, 100n);
const REASONER = descriptorOf('a/reasoner', LADDER);
const OTHER = descriptorOf('b/reasoner', LADDER, 3000n);

const CATALOG: readonly ModelDescriptor[] = [ENGINE, REASONER, OTHER];
const resolve: ModelPricingResolver = (id) => CATALOG.find((model) => model.id === id);

const BUDGET: TurnBudget = {
  promptCharacterCount: 400,
  inputCharacterCount: 400,
  funding: { kind: 'purchased', spendableNanoUsd: 5_000_000_000n },
};

/** A multi-model compile the test expects to build. */
function builtTurn(result: Result<MultiModelTurnOutcome, DomainError>): MultiModelTurnBuild {
  const outcome = result._unsafeUnwrap();
  if (outcome.kind !== 'built') throw new Error('expected a built turn');
  return outcome;
}

function compileAuto(models: readonly string[] = [REASONER.id, OTHER.id]): {
  readonly nodes: readonly Node[];
  readonly classifierPrompt: string | undefined;
  readonly decisionDomain: string | undefined;
} {
  const build = builtTurn(
    compileMultiModelTurnOutcome(resolve, models, {
      budget: BUDGET,
      reasoningEffort: 'auto',
      nowMs: TEST_DAY_START,
      catalog: CATALOG,
    })
  );
  const domain = turnInputs(build, TURN_PROMPT, [])[CHAT_DECISION_DOMAIN_INPUT];
  return {
    nodes: build.definition.nodes,
    classifierPrompt: build.classifier?.prompt,
    decisionDomain: domain?.kind === 'text' ? domain.text : undefined,
  };
}

function classifierNode(nodes: readonly Node[]): Extract<Node, { type: 'modelCall' }> {
  const found = nodes.find((node): node is Extract<Node, { type: 'modelCall' }> =>
    isTurnClassifierNode(node, nodes)
  );
  if (found === undefined) throw new Error('the compiled turn has no classifier node');
  return found;
}

/** A conversation far past the truncation budget on both sides. */
const LONG_USER = 'u'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS * 3);
const LONG_ASSISTANT = 'a'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS * 3);

/**
 * Exactly what the run receives — read out of the PRODUCTION assembler rather
 * than rebuilt here. A reassembled twin would keep passing while `turnInputs`
 * changed what it actually sends, which is the failure mode every bound on the
 * classifier reserve exists to catch.
 */
function assembledInput(): string {
  const build = builtTurn(
    compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      nowMs: TEST_DAY_START,
      catalog: CATALOG,
    })
  );
  const inputs = turnInputs(build, LONG_USER, [{ role: 'assistant', content: LONG_ASSISTANT }]);
  const classifierInput = inputs[CHAT_CLASSIFIER_INPUT];
  if (classifierInput?.kind !== 'text') {
    throw new Error('the classifying turn declared no classifier input');
  }
  return classifierInput.text;
}

/**
 * What admission holds for the classifier alone: the compiled definition priced
 * by the canonical estimator, less the same definition with the classifier node
 * dropped. Subtracting leaves every other term priced exactly as the run prices
 * it — the answer legs, the once-per-turn prompt storage, and the consumed-node
 * rule that gives a classifier no output storage.
 */
function heldClassifierReserve(
  definition: WorkflowDefinition,
  catalog: readonly ModelDescriptor[]
): bigint {
  const estimate = createEstimateRun((id) => catalog.find((model) => model.id === id));
  const classifier = classifierNode(definition.nodes);
  const withoutClassifier = {
    ...definition,
    nodes: definition.nodes.filter((node) => node.id !== classifier.id),
  };
  return (
    estimate(definition)._unsafeUnwrap().totalNanoUsd -
    estimate(withoutClassifier)._unsafeUnwrap().totalNanoUsd
  );
}

/** The `auto` text shape a multi-model send compiles to: classify → decide → N sibling calls. */
function multiModelAutoDefinition(catalog: readonly ModelDescriptor[]): WorkflowDefinition {
  return builtTurn(
    compileMultiModelTurnOutcome(
      (id) => catalog.find((model) => model.id === id),
      [REASONER.id, OTHER.id],
      { budget: BUDGET, reasoningEffort: 'auto', nowMs: TEST_DAY_START, catalog }
    )
  ).definition;
}

describe('one predicate answers whether a turn buys a classifier', () => {
  it('classifies a selection presenting two or more effort options', () => {
    expect(turnClassifies([REASONER.id, OTHER.id], resolve)).toBe(true);
  });

  it('classifies a single model that presents the options on its own', () => {
    expect(turnClassifies([REASONER.id], resolve)).toBe(true);
  });

  it('buys no classifier for a model offering a single mandatory rung', () => {
    const oneRung = descriptorOf('d/one-rung', { mandatory: true, supportedEfforts: ['high'] });
    const catalog = [ENGINE, oneRung];
    expect(turnClassifies([oneRung.id], (id) => catalog.find((m) => m.id === id))).toBe(false);
  });

  it('buys no classifier for a model presenting no effort option at all', () => {
    const plain = descriptorOf('c/plain');
    const catalog = [ENGINE, plain];
    expect(turnClassifies([plain.id], (id) => catalog.find((m) => m.id === id))).toBe(false);
  });

  it('buys no classifier for a model the resolver cannot see', () => {
    expect(turnClassifies(['nobody/knows-me'], resolve)).toBe(false);
  });
});

describe('the multi-model auto turn compiles a classifier', () => {
  it('derives exactly one classifier from the decision reducer', () => {
    const { nodes } = compileAuto();
    expect(nodes.filter((node) => isTurnClassifierNode(node, nodes))).toHaveLength(1);
  });

  it('runs the classifier on the cheapest priceable engine, not on a selected model', () => {
    expect(classifierNode(compileAuto().nodes).model).toBe(ENGINE.id);
  });

  it('caps the classifier call at the output cap its reserve is priced against', () => {
    // The constant had no production consumer: the reserve priced a cap the
    // request did not enforce.
    expect(classifierNode(compileAuto().nodes).params['maxOutputTokens']).toBe(
      CLASSIFIER_OUTPUT_TOKEN_CAP
    );
  });

  it('lets a classifier failure skip rather than fail the turn', () => {
    const node = classifierNode(compileAuto().nodes);
    expect({ optional: node.optional, onError: node.onError }).toEqual({
      optional: true,
      onError: 'skip',
    });
  });

  it('feeds every sibling the decision rather than the raw prompt', () => {
    const { nodes } = compileAuto();
    const siblings = nodes.filter(
      (node) => node.type === 'modelCall' && !isTurnClassifierNode(node, nodes)
    );
    const decide = nodes.find((node) => node.type === 'fanIn');
    expect(siblings).toHaveLength(2);
    expect(decide?.type === 'fanIn' && decide.reducer).toBe(TURN_DECISION_REDUCER);
    for (const sibling of siblings) {
      expect(sibling.type === 'modelCall' && sibling.in.node).toBe(decide?.id);
    }
  });

  it('leaves a pinned-effort turn exactly as it was — no classifier, no second input', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'medium',
        catalog: CATALOG,
      })
    );
    expect(build.classifier).toBeUndefined();
    expect(build.definition.nodes.filter((node) => node.type === 'fanIn')).toHaveLength(0);
  });

  it('buys no classifier when the turn has fewer than two real choices', () => {
    // Two non-reasoning models offer no effort choice at all, so the answer is
    // settled and no call is bought.
    const plain = descriptorOf('c/plain');
    const catalog = [ENGINE, plain];
    const build = builtTurn(
      compileMultiModelTurnOutcome((id) => catalog.find((m) => m.id === id), [plain.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog,
      })
    );
    expect(build.classifier).toBeUndefined();
  });
});

describe('an absent catalog is an empty one, not an opt-out', () => {
  it('refuses a classifiable auto turn rather than silently leaving it unclassified', () => {
    // Omission must not be a quiet way to disable classification: a caller that
    // forgot the snapshot would otherwise ship unclassified `auto` turns, which
    // is the regression this path exists to remove and is invisible.
    const refused = compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      nowMs: TEST_DAY_START,
    });
    expect(refused._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('refuses a classifiable auto turn with no budget the same way', () => {
    const refused = compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      reasoningEffort: 'auto',
    });
    expect(refused._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('leaves a pinned-effort turn alone, because it never asks for an engine', () => {
    const built = compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'medium',
    });
    expect(builtTurn(built).classifier).toBeUndefined();
  });
});

/**
 * The rungs the browser's own admissible menu marks available for a pinned
 * `auto` turn at {@link BUDGET}, read off the one producer over the one pool
 * projection, so the classifier's options are compared with what the payer is
 * offered rather than with a list rebuilt here.
 */
function menuRungs(
  models: readonly ModelDescriptor[],
  catalog: readonly ModelDescriptor[],
  budget: TurnBudget = BUDGET
): readonly string[] {
  const [first, ...rest] = models;
  if (first === undefined) throw new Error('expected a model');
  const options = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(budget.funding.spendableNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    promptBasisFromTotal({
      promptChars: budget.promptCharacterCount,
      inputChars: budget.inputCharacterCount,
    }),
    {
      answerSources: {
        models: [modelId(first.id), ...rest.map((model) => modelId(model.id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models: smartModelPool(catalog), nowMs: TEST_DAY_START }
  );
  return options.admissible.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

describe('the classifier is offered the rungs the turn’s own menu marks available', () => {
  it('omits a declared rung the turn does not present', () => {
    // `lite` is in the effort dimension's declared domain; a positional ladder
    // of three rungs presents Low/Mid/High, so Lite is not the turn's to offer.
    const threeRung: ModelReasoning = { supportedEfforts: ['low', 'medium', 'high'] };
    const narrow = descriptorOf('d/three', threeRung);
    const catalog = [ENGINE, narrow];
    const build = builtTurn(
      compileMultiModelTurnOutcome((id) => catalog.find((m) => m.id === id), [narrow.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog,
      })
    );

    expect(build.classifier?.decisionDomain.presentedEfforts).not.toContain('lite');
    expect(build.classifier?.decisionDomain.presentedEfforts).toEqual(menuRungs([narrow], catalog));
  });

  it('offers exactly the rungs the menu marks available', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );

    expect(build.classifier?.decisionDomain.presentedEfforts).toEqual(
      menuRungs([REASONER, OTHER], CATALOG)
    );
  });

  it('withholds a rung the turn offers but its answers’ caps cannot hold', () => {
    // Every row here caps its completion below the Max rung's budget, so the
    // turn offers Max and no funding makes it available.
    const offered = presentedEffortOptions([REASONER.id, OTHER.id], resolve).map(
      (option) => option.optionId
    );
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );

    expect(offered).toContain('max');
    expect(build.classifier?.decisionDomain.presentedEfforts).not.toContain('max');
  });
});

describe('the effort plan of a turn whose models were pinned', () => {
  it('presents every rung the models offer when the build carries no budget', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        reasoningEffort: 'auto',
        catalog: CATALOG,
      })
    );

    expect(build.classifier?.decisionDomain.presentedEfforts).toEqual(
      presentedEffortOptions([REASONER.id, OTHER.id], resolve).map((option) => option.optionId)
    );
  });

  it('refuses a classifying auto turn with a budget but no instant to grade its menu at', () => {
    const refused = compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog: CATALOG,
    });

    expect(refused._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a funded auto turn whose menu marks no rung available', () => {
    // 2 cents: the models offer the whole ladder and the funding holds no rung of it.
    const broke: TurnBudget = {
      ...BUDGET,
      funding: { kind: 'purchased', spendableNanoUsd: 20_000_000n },
    };
    const outcome = compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
      budget: broke,
      reasoningEffort: 'auto',
      nowMs: TEST_DAY_START,
      catalog: CATALOG,
    })._unsafeUnwrap();

    expect(menuRungs([REASONER, OTHER], CATALOG, broke)).toEqual([]);
    expect(outcome.kind).toBe('unaffordable');
  });

  describe('a menu that marks exactly one rung available', () => {
    // 5 cents: the models offer the whole ladder and the funding holds Min alone.
    const oneRung: TurnBudget = {
      ...BUDGET,
      funding: { kind: 'purchased', spendableNanoUsd: 50_000_000n },
    };
    const build = (): MultiModelTurnBuild =>
      builtTurn(
        compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
          budget: oneRung,
          reasoningEffort: 'auto',
          nowMs: TEST_DAY_START,
          catalog: CATALOG,
        })
      );

    it('marks Min alone available at this funding', () => {
      expect(menuRungs([REASONER, OTHER], CATALOG, oneRung)).toEqual(['off']);
    });

    it('buys no classifier call for the settled choice', () => {
      const nodes = build().definition.nodes;
      expect(build().classifier).toBeUndefined();
      expect(nodes.some((node) => isTurnClassifierNode(node, nodes))).toBe(false);
    });

    it('runs every answer at the one available rung', () => {
      const answers = build().definition.nodes.filter((node) => node.type === 'modelCall');
      expect(answers.map((node) => node.reasoningEffort)).toEqual(answers.map(() => 'off'));
    });
  });
});

describe('a multi-model auto turn over models that cannot turn reasoning off is refused below its cheapest rung', () => {
  /** GPT-5.4 Pro's catalog row: mandatory reasoning over a three-word ladder. */
  const pro: ModelDescriptor = {
    ...descriptorOf('openai/gpt-5.4-pro', {
      mandatory: true,
      defaultEffort: 'medium',
      supportedEfforts: ['xhigh', 'high', 'medium'],
    }),
    inputs: ['text', 'image'],
    limits: { contextLength: 1_050_000, maxOutputTokens: 128_000 },
    pricing: tokenPricingFixture({ input: 34_500n, output: 207_000n }),
  };
  const mandatory = descriptorOf('b/mandatory', {
    mandatory: true,
    supportedEfforts: ['high', 'medium', 'low'],
  });
  const catalog: readonly ModelDescriptor[] = [ENGINE, pro, mandatory];
  const ONE_CENT = 10_000_000n;

  /** A 1,756-character prompt on a purchased balance of `spendable`. */
  function budgetOf(spendable: bigint): TurnBudget {
    return {
      promptCharacterCount: 1756,
      inputCharacterCount: 1756,
      funding: { kind: 'purchased', spendableNanoUsd: spendable },
    };
  }

  function composerFunds(spendable: bigint): boolean {
    return menuRungs([pro, mandatory], catalog, budgetOf(spendable)).length > 0;
  }

  function serverKind(spendable: bigint): MultiModelTurnOutcome['kind'] {
    return compileMultiModelTurnOutcome(
      (id) => catalog.find((model) => model.id === id),
      [pro.id, mandatory.id],
      { budget: budgetOf(spendable), reasoningEffort: 'auto', nowMs: TEST_DAY_START, catalog }
    )._unsafeUnwrap().kind;
  }

  /** The least whole-cent balance at which the composer funds a rung, by bisection. */
  function composerThreshold(): bigint {
    let unfunded = 51n * ONE_CENT;
    let funded = 10_000n * ONE_CENT;
    if (composerFunds(unfunded) || !composerFunds(funded)) {
      throw new Error('expected the bisection bounds to straddle the threshold');
    }
    while (funded - unfunded > ONE_CENT) {
      const mid = unfunded + ((funded - unfunded) / ONE_CENT / 2n) * ONE_CENT;
      if (composerFunds(mid)) funded = mid;
      else unfunded = mid;
    }
    return funded;
  }

  const threshold = composerThreshold();

  it('refuses at $0.51, where the composer funds no rung', () => {
    expect(composerFunds(51n * ONE_CENT)).toBe(false);
    expect(serverKind(51n * ONE_CENT)).toBe('unaffordable');
  });

  it('refuses one cent below the balance that funds the cheapest rung', () => {
    expect(composerFunds(threshold - ONE_CENT)).toBe(false);
    expect(serverKind(threshold - ONE_CENT)).toBe('unaffordable');
  });

  it('builds at the balance that funds the cheapest rung', () => {
    expect(composerFunds(threshold)).toBe(true);
    expect(serverKind(threshold)).toBe('built');
  });
});

describe('the assembled classifier call fits the amount reserved for it', () => {
  it('sends no more input than the classifier reserve priced', () => {
    // `reserve ⊇ bill` on the real assembled request. The reserve prices the
    // truncation budget plus the rendered template; the request must not exceed
    // it — and with the base system preamble suppressed for a routing call,
    // nothing else is added downstream.
    expect(assembledInput().length).toBeLessThanOrEqual(classifierReserveChars([]));
  });

  it('still spends most of the budget on conversation rather than template', () => {
    // A bound that holds only because the excerpt is empty would be worthless.
    expect(assembledInput().length).toBeGreaterThan(MAX_CLASSIFIER_CONTEXT_CHARS);
  });
});

/**
 * The payer freeze prices an `auto` turn's classifier from `pickEffortClassifier`
 * over the catalog snapshot the gated resolution read; admission holds whatever the
 * classifier NODE of the compiled definition prices through the canonical
 * estimator, over the snapshot the build resolved for itself. Two reads, two
 * engine selections — so if the freeze's figure is ever the smaller, the turn's
 * minimum under-states the hold and the group-headroom band that clears the
 * freeze and then fails admission reopens for `auto` alone.
 */
describe('the freeze reserve bounds what admission holds for the classifier', () => {
  /** The payer freeze's own figure, from the producer its classifier reserve calls. */
  function freezeReserve(catalog: readonly ModelDescriptor[]): bigint {
    const pick = pickEffortClassifier(catalog);
    if (pick === null) throw new Error('the fixture catalog prices no classifier engine');
    return pick.classifierWorstCaseNanoUsd;
  }

  /** The shape a single-model `auto` send compiles to: classify → decide → slot. */
  function pinnedAutoDefinition(catalog: readonly ModelDescriptor[]): WorkflowDefinition {
    const build = compileAutoEffortTurn(catalog, REASONER.id, {
      budget: BUDGET,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(TEST_DAY_START),
    })._unsafeUnwrap();
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    return build.definition;
  }

  it('holds no more for a pinned-model auto turn than the freeze priced', () => {
    expect(heldClassifierReserve(pinnedAutoDefinition(CATALOG), CATALOG)).toBeLessThanOrEqual(
      freezeReserve(CATALOG)
    );
  });

  it('holds no more for a multi-model auto turn than the freeze priced', () => {
    expect(heldClassifierReserve(multiModelAutoDefinition(CATALOG), CATALOG)).toBeLessThanOrEqual(
      freezeReserve(CATALOG)
    );
  });

  it('reads the reserve off the classifier call, not off the slot that consumes it', () => {
    // Naming the arm under measurement: an `auto` turn's slot is fed the
    // decision from outside, so it declares an input schema and the estimator
    // prices NO reserve inside it. The classifier's price rides the ordinary
    // modelCall above — the node this describe subtracts.
    const definition = pinnedAutoDefinition(CATALOG);
    expect(classifierNode(definition.nodes).type).toBe('modelCall');
    const slot = definition.nodes.find((node) => node.type === 'smartModel');
    if (slot?.type !== 'smartModel')
      throw new Error('the compiled auto turn has no smartModel slot');
    expect(slot.inputSchema).toBeDefined();
  });

  it('measures a reserve rather than nothing at all', () => {
    // A subtraction that came back zero would satisfy both bounds for free.
    expect(heldClassifierReserve(pinnedAutoDefinition(CATALOG), CATALOG)).toBeGreaterThan(0n);
  });

  it('exceeds the freeze figure when the build reads a dearer engine than the freeze priced', () => {
    // The live divergence is the two catalog reads: a model that vanishes
    // between them leaves the build on a dearer engine than the freeze priced,
    // and the hold above the minimum. The bounds above must be able to express
    // that direction, or they pin nothing.
    const withoutEngine = CATALOG.filter((model) => model.id !== ENGINE.id);
    expect(
      heldClassifierReserve(pinnedAutoDefinition(withoutEngine), withoutEngine)
    ).toBeGreaterThan(freezeReserve(CATALOG));
  });
});

/**
 * The money leg of the same bound: the characters the production assembler
 * puts in front of the classifier, carried through the stamp and the canonical
 * estimator into the figure admission holds.
 *
 * The character bound stops at a count, and nothing carried that count into
 * money. So a stamp derived from any other basis — the truncation budget
 * without the template, or a constant — left the character bound green while
 * admission held for a quantity of text that was not the quantity about to be
 * sent.
 */
describe('the classifier hold is priced from the characters the classifier is presented', () => {
  /**
   * The same hold, restamped as though the classifier's input leg were the given
   * character count. Only the classifier node's stamp moves, so the difference
   * between two calls is the price of a difference in presented characters and
   * nothing else.
   */
  function heldForInputChars(definition: WorkflowDefinition, characterCount: number): bigint {
    const classifier = classifierNode(definition.nodes);
    return heldClassifierReserve(
      {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === classifier.id
            ? {
                ...classifier,
                promptInputTokens: inputTokensOf(characterCount),
              }
            : node
        ),
      },
      CATALOG
    );
  }

  it('holds at least what the characters the assembler presents price at', () => {
    const definition = multiModelAutoDefinition(CATALOG);
    expect(heldClassifierReserve(definition, CATALOG)).toBeGreaterThanOrEqual(
      heldForInputChars(definition, assembledInput().length)
    );
  });

  it('would not cover an excerpt one truncation budget past what the assembler sends', () => {
    // The bound bites at the scale it is asserted over: the hold covers the
    // presented characters because it is priced from them, not because the
    // figure is large enough to cover anything.
    const definition = multiModelAutoDefinition(CATALOG);
    expect(
      heldForInputChars(definition, assembledInput().length + MAX_CLASSIFIER_CONTEXT_CHARS)
    ).toBeGreaterThan(heldClassifierReserve(definition, CATALOG));
  });
});

describe('the decision reaches the siblings', () => {
  /** The REGISTERED reducer, resolved the way the interpreter resolves it. */
  const decide = reducerCode(DEFAULT_WORKFLOW_CAPABILITIES).get(TURN_DECISION_REDUCER);
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);

  /** Captures the InferenceRequest a sibling's execution actually sends. */
  async function runSibling(input: unknown): Promise<InferenceRequest> {
    const { nodes } = compileAuto();
    const sibling = nodes.find(
      (node): node is Extract<Node, { type: 'modelCall' }> =>
        node.type === 'modelCall' && !isTurnClassifierNode(node, nodes)
    );
    if (sibling === undefined) throw new Error('no sibling in the compiled turn');
    const requests: InferenceRequest[] = [];
    const execution = createModelCallExecution({
      provider: {
        infer: (request) => {
          requests.push(request);
          return (async function* stream(): AsyncGenerator<InferenceEvent> {
            await Promise.resolve();
            yield {
              kind: 'finish',
              metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
            };
          })();
        },
      },
      binding: {
        descriptor: REASONER,
        ports: { in: [textTag()], out: textTag() },
        price: () => ok(0n),
      },
      usdToBillableNanoUsd: () => 0n,
      schemas: {
        resolveSchema: (name) => constraints.resolve('schema', name)?.schema,
      },
    });
    await execution.run(sibling, [input], {
      values: createValueStore(1_000_000),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      signal: new AbortController().signal,
    });
    const sent = requests[0];
    if (sent === undefined) throw new Error('the sibling sent no request');
    return sent;
  }

  it('applies the level the classifier actually chose, not the fallback', async () => {
    // The presented set is read off the compiled turn rather than restated: a
    // rung the turn never presented is not honoured, so a fixture that omitted
    // it would drive both calls to the fallback and pin nothing.
    const { decisionDomain } = compileAuto();
    const chosen = decide?.([
      TURN_PROMPT,
      `effort: ${REASONING_EFFORT_LABELS.low}`,
      decisionDomain,
    ]);
    const fallback = decide?.([TURN_PROMPT, undefined, decisionDomain]);
    // The pin discriminates only if the two differ: a classifier whose choice
    // equalled the fallback would prove nothing about the answer being read.
    expect((chosen as { effort: string }).effort).not.toBe((fallback as { effort: string }).effort);

    const [chosenRequest, fallbackRequest] = [await runSibling(chosen), await runSibling(fallback)];
    expect(chosenRequest.parameters['reasoning']).toEqual({ effort: 'low' });
    expect(fallbackRequest.parameters['reasoning']).not.toEqual(
      chosenRequest.parameters['reasoning']
    );
  });

  it('falls back rather than failing when the classifier produced no answer', async () => {
    const request = await runSibling(decide?.([TURN_PROMPT, undefined]));
    expect(request.parameters['reasoning']).toBeDefined();
    expect(request.inputs[0]).toEqual({ modality: 'text', text: TURN_PROMPT });
  });

  it('sends the turn prompt, never the envelope, to the provider', async () => {
    const request = await runSibling(
      decide?.([TURN_PROMPT, `effort: ${REASONING_EFFORT_LABELS.max}`])
    );
    expect(request.inputs).toEqual([{ modality: 'text', text: TURN_PROMPT }]);
  });
});

describe('the turn refuses rather than picking an effort itself', () => {
  it('fails with the typed classifier code when no engine can price the call', () => {
    // §Reasoning Effort 5(d): no priceable classifier engine is a typed refusal,
    // never a silent static level — explicit levels stay usable.
    const rateless = {
      ...REASONER,
      id: 'e/rateless',
      pricing: {},
    } as unknown as ModelDescriptor;
    const catalog = [rateless];
    const failed = compileMultiModelTurnOutcome(
      (id) => catalog.find((m) => m.id === id),
      [rateless.id],
      {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog,
      }
    );
    expect(failed._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });
});

describe('the run inputs carry the classifier prompt only when the turn classifies', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'earlier question' },
    { role: 'assistant' as const, content: 'earlier answer' },
  ];

  it('sends one input for a pinned-effort turn', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'medium',
        catalog: CATALOG,
      })
    );
    expect(Object.keys(turnInputs(build, TURN_PROMPT, HISTORY))).toEqual([CHAT_TURN_INPUT]);
  });

  it('sends the rendered prompt and the excerpt for an auto turn', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );
    const inputs = turnInputs(build, TURN_PROMPT, HISTORY);
    const classifierInput = inputs[CHAT_CLASSIFIER_INPUT];
    expect(new Set(Object.keys(inputs))).toEqual(
      new Set([CHAT_CLASSIFIER_INPUT, CHAT_DECISION_DOMAIN_INPUT, CHAT_TURN_INPUT])
    );
    // The excerpt reaches the classifier: both sides of the latest exchange.
    expect(classifierInput?.kind === 'text' && classifierInput.text).toContain('earlier answer');
    expect(classifierInput?.kind === 'text' && classifierInput.text).toContain(TURN_PROMPT);
  });

  it('carries the presented effort options on to the reducer', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );
    const ids = build.classifier?.decisionDomain.presentedEfforts ?? [];
    // The set the prompt rendered, in the same order — the reducer's fallback is
    // its first entry, so an empty or reordered list would move what the turn runs.
    expect(ids.length).toBeGreaterThan(1);
    const prompt = build.classifier?.prompt ?? '';
    for (const id of ids) expect(prompt).toContain(REASONING_EFFORT_LABELS[id]);
  });

  it('hands the reducer the decision domain the turn compiled', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );
    const domain = build.classifier?.decisionDomain;
    if (domain === undefined) throw new Error('expected an auto turn that classifies');

    expect(CHAT_DECISION_DOMAIN_INPUT).toBe('decisionDomain');
    expect(turnInputs(build, TURN_PROMPT, HISTORY)[CHAT_DECISION_DOMAIN_INPUT]).toEqual({
      kind: 'text',
      text: decisionDomainInput(domain),
    });
  });

  it('lists no candidate for a turn with no Smart Model slot', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolve, [REASONER.id, OTHER.id], {
        budget: BUDGET,
        reasoningEffort: 'auto',
        nowMs: TEST_DAY_START,
        catalog: CATALOG,
      })
    );

    expect(build.classifier?.decisionDomain.candidates).toEqual([]);
  });
});

describe('the decision domain a classifying turn hands its reducer', () => {
  const MIN_AND_LITE = [
    { optionId: 'off', label: REASONING_EFFORT_LABELS.off },
    { optionId: 'lite', label: REASONING_EFFORT_LABELS.lite },
  ];

  it('lists each candidate, in the slot’s order, with the presented rungs it answers at', () => {
    const domain = decisionDomainFor(MIN_AND_LITE, [
      { id: 'vendor/engine', rungCeilings: { off: 900, lite: 800 } },
      { id: 'vendor/mandatory', rungCeilings: { off: 8033 } },
    ]);

    expect(domain).toEqual({
      presentedEfforts: ['off', 'lite'],
      candidates: [
        { id: 'vendor/engine', answerableRungs: ['off', 'lite'] },
        { id: 'vendor/mandatory', answerableRungs: ['off'] },
      ],
    });
  });

  it('lets a candidate with no per-rung record answer at every presented rung', () => {
    const domain = decisionDomainFor(MIN_AND_LITE, [{ id: 'vendor/open', maxOutputTokens: 700 }]);

    expect(domain.candidates).toEqual([{ id: 'vendor/open', answerableRungs: ['off', 'lite'] }]);
  });
});
