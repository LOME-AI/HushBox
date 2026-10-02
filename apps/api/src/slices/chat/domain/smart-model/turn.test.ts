import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  REASONING_OFF_WIRE,
  getTurnOptions,
  isTurnClassifierNode,
  modelId,
  nanoUSD,
  promptBasisFromTotal,
  PAID_CUSHION_NANO_USD,
  WEB_SEARCH_ROW_MAX_CHARS,
} from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { classifierWorstCaseNanoUsd } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import {
  WEB_SEARCH_RESULT_MAX_CHARS,
  toolCallBillableNano,
  toolCallCapFor,
  toolLoopBound,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import { DAY_MS, OLD_RELEASE_SECONDS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { perImagePricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { TURN_DECISION_SCHEMA_NAME } from '../../../workflows/index.js';
import {
  createTurnCompileRegistries,
  multiModelNodeId,
  payerSpendableNanoUsd,
  promptInputTokensFor,
  sharedAnswerCeiling,
  turnModelPricings,
  withStorageStamp,
} from '../turn/definition.js';
import { CHAT_CLASSIFIER_NODE_ID, CHAT_DECISION_NODE_ID } from '../turn/classifier.js';
import { COST_CIRCUIT_MULTIPLIER } from '../../../billing/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from '../constants.js';
import {
  buildSmartModelTurn,
  compileSmartModelBuild,
  compileAutoEffortTurn,
  effortDimensionForCandidates,
  smartModelEffectiveBalanceNanoUsd,
  turnSiblings,
} from './turn.js';
import {
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  createEstimateRun,
  estimateRunCeilingNanoUsd,
  snapshotResolver,
} from '../../../models/index.js';
import { smartModelPool } from '../../../models/domain/smart-model/candidates.js';
import type { AutoEffortTurnBuild } from './turn.js';
import type { MultiModelTurnBuild, TurnBudget } from '../turn/definition.js';
import type { ModelPricingResolver, SmartModelCandidates } from '../../../models/index.js';
/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

import type { ModelDescriptor, UserTier, WorkflowDefinition } from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { NanoUSD } from '@hushbox/shared';

/** A token-priced descriptor as the shared reserve reads it. */
function tokenPriced(descriptor: ModelDescriptor): {
  readonly pricing: Extract<ModelDescriptor['pricing'], { kind: 'tokens' }>;
} {
  if (descriptor.pricing.kind !== 'tokens') {
    throw new Error(`fixture '${descriptor.id}' is not priced by the token`);
  }
  return { pricing: descriptor.pricing };
}

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

function descriptorFor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1000 },
    pricing: tokenPricingFixture({ input: 2n, output: 3n }),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
  };
}

const KNOWN_MODELS = new Set(['cheap-model', 'mid-model', 'sibling-model']);
const resolver: ModelPricingResolver = (id) =>
  KNOWN_MODELS.has(id) ? descriptorFor(id) : undefined;

/** A priced text descriptor with explicit per-token rates and context window. */
function priced(
  id: string,
  inputRate: bigint,
  outputRate: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    limits: { contextLength },
    pricing: tokenPricingFixture({ input: inputRate, output: outputRate }),
  };
}

const ONE_USD = 1_000_000_000n;

describe("smartModelEffectiveBalanceNanoUsd (the payer's frozen spendable funds)", () => {
  // The affordability gate must reason over the SAME figure the admission Redis
  // gate and the client affordability preflight use. That figure is resolved once
  // where the payer wallet is picked and frozen onto the budget, cushion already
  // applied; re-deriving it here (the prior bug, in both directions) is what let
  // the gate refuse sends the client accepts.
  it("reads a purchased payer's frozen spendable funds, cushion and all", () => {
    const budget = {
      promptCharacterCount: 100,
      inputCharacterCount: 100,
      funding: { spendableNanoUsd: PAID_CUSHION_NANO_USD, kind: 'purchased' as const },
    };
    expect(smartModelEffectiveBalanceNanoUsd(budget, 999n)).toBe(PAID_CUSHION_NANO_USD);
  });

  it("reads a free-tier payer's remaining allowance, which carries no cushion", () => {
    const budget = {
      promptCharacterCount: 100,
      inputCharacterCount: 100,
      funding: { spendableNanoUsd: 5000n, kind: 'free' as const },
    };
    expect(smartModelEffectiveBalanceNanoUsd(budget, 999n)).toBe(5000n);
  });

  it('falls back to the sender purchased balance when no budget is supplied', () => {
    expect(smartModelEffectiveBalanceNanoUsd(undefined, 12_345n)).toBe(12_345n);
  });
});

describe('Smart Model admission reserve tracks the AFFORDABLE subset (legacy behavior)', () => {
  // A catalog whose text models ladder in price. The founder decision reserves
  // the worst case over ONLY the models the wallet can afford (legacy
  // `findAffordableCandidates`): a small wallet admits just the cheap models and
  // reserves little; a large wallet admits the whole pool and reserves the
  // priciest candidate's worst case — the same bounded MAX the old fixed menu
  // held, so a well-funded wallet's concurrency is not regressed.
  const CATALOG = [
    priced('a/cheap', 2n, 3n, 8000),
    priced('m/a', 2_500_000n, 2_500_000n, 1000),
    priced('m/b', 25_000_000n, 25_000_000n, 1000),
    priced('m/c', 250_000_000n, 250_000_000n, 1000),
  ];
  const resolver = snapshotResolver(CATALOG);

  /** The realised admission reserve for a solo paid send at a given balance,
   * built through the no-budget path (the uncapped defensive build the route
   * takes when no budget is supplied) and priced by the real estimator. */
  function reserveAtBalance(balanceNanoUsd: bigint): bigint {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd,
      tier: 'paid',
      promptChars: 0,
      inputChars: 0,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: NOW_MS,
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    return createEstimateTotal(resolver)(definition)._unsafeUnwrap();
  }

  it('refuses the send outright when the wallet cannot fund even the cheapest candidate', () => {
    expect(
      buildSmartModelCandidates({
        descriptors: CATALOG,
        balanceNanoUsd: 0n,
        tier: 'paid',
        promptChars: 0,
        inputChars: 0,
        pinnedModelIds: [],
        webSearch: false,
        nowMs: NOW_MS,
      })
    ).toBeNull();
  });

  it('grows the reserve as the balance admits progressively pricier candidates', () => {
    const low = reserveAtBalance(10n * ONE_USD);
    const mid = reserveAtBalance(100n * ONE_USD);
    const high = reserveAtBalance(1000n * ONE_USD);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it('does not regress a well-funded wallet: the full-pool subset reserves the priciest candidate worst case, never the balance', () => {
    const HUGE_BALANCE = 10n ** 15n;
    const fullPoolReserve = reserveAtBalance(HUGE_BALANCE);
    // The priciest candidate over its own full context — the MAX the estimator
    // holds once every model is affordable (the old bounded, balance-invariant
    // reserve). A large wallet reserves exactly this plus the classifier, never
    // the balance itself, so concurrent-run capacity is preserved.
    const priciestFullContext = estimateRunCeilingNanoUsd(
      CATALOG[3]!.pricing,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 1, maxIterations: 1 }
    )._unsafeUnwrap();
    expect(fullPoolReserve < HUGE_BALANCE).toBe(true);
    expect(fullPoolReserve).toBeGreaterThanOrEqual(priciestFullContext);
    expect(fullPoolReserve).toBeLessThan(priciestFullContext * 2n);
  });
});

describe('Smart Model per-candidate caps keep the reserve within the balance (money keystone)', () => {
  // Each eligible candidate carries its OWN affordable cap: a cheap wide model
  // reaches (much of) its context, a pricey one is budget-bound — and the
  // admission reserve (MAX over the subset, priced EXACTLY as the estimator with
  // storage) never exceeds the wallet. The old single-cap throttle (everyone to
  // the tightest window) is gone.
  const WIDE_CONTEXT = 1_050_000;
  const TIGHT_CONTEXT = 8000;
  const CHEAP_CLASSIFIER = priced('cheap/classifier', 2n, 3n, TIGHT_CONTEXT);
  const CATALOG = [CHEAP_CLASSIFIER, priced('wide/pro', 4n, 200_000n, WIDE_CONTEXT)];
  const CANDIDATE_IDS = [{ id: 'cheap/classifier' }, { id: 'wide/pro' }];
  const HUNDRED_USD = 100n * ONE_USD;
  const budget = {
    promptCharacterCount: 400,
    inputCharacterCount: 400,
    funding: { spendableNanoUsd: HUNDRED_USD, kind: 'purchased' as const },
  };

  /** The admission pick this catalog, prompt and wallet produce. */
  function paidCandidates(): NonNullable<ReturnType<typeof buildSmartModelCandidates>> {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: HUNDRED_USD,
      tier: 'paid',
      promptChars: budget.promptCharacterCount,
      inputChars: budget.inputCharacterCount,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: NOW_MS,
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    return picked;
  }

  /** Mirrors `buildSmartModelTurnDefinition`'s paid path: per-candidate caps
   * (from the storage-aware admission), no single node cap, storage-stamped. */
  function paidDefinition(): WorkflowDefinition {
    const picked = paidCandidates();
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    const built = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    return withStorageStamp(built, budget, CHAT_TURN_HOOKS);
  }

  it('stamps each eligible candidate its own affordable cap (≥ MINIMUM), no single node cap', () => {
    const node = paidDefinition().nodes.at(-1);
    expect(node).toMatchObject({ type: 'smartModel' });
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    expect(node.params['maxOutputTokens']).toBeUndefined();
    for (const candidate of node.candidates) {
      expect(candidate.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    }
  });

  it('the storage-inclusive admission reserve stays within the balance (no under-reserve, no 402)', () => {
    const estimate = createEstimateTotal(snapshotResolver(CATALOG))(
      paidDefinition()
    )._unsafeUnwrap();
    expect(estimate).toBeGreaterThan(0n);
    expect(estimate).toBeLessThanOrEqual(HUNDRED_USD);
  });

  it('still refuses a genuinely unaffordable wallet (builder affordability gate)', () => {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: 1n,
      tier: 'paid',
      promptChars: budget.promptCharacterCount,
      inputChars: budget.inputCharacterCount,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: NOW_MS,
    });
    expect(picked).toBeNull();
  });

  /** The larger of two nano-USD figures; `Math.max` cannot take bigints. */
  function larger(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
  }

  /**
   * The paid definition restricted to ONE of its candidates, keeping that
   * candidate's own stamped cap. A one-candidate slot opens no model dimension,
   * so its reserve is the answer leg alone — the direct-pick figure. That is what
   * makes the pool's reserve decomposable without re-deriving any of the
   * estimator's arithmetic here.
   */
  function soloReserve(modelId: string): bigint {
    const pooled = paidDefinition().nodes.at(-1);
    if (pooled?.type !== 'smartModel') throw new Error('expected a smartModel node');
    const only = pooled.candidates.find((candidate) => candidate.id === modelId);
    if (only === undefined) throw new Error(`expected ${modelId} among the candidates`);
    // The answer leg alone: one candidate, and the classifier stage dropped —
    // it is a node of its own now, so removing it is what leaves a direct pick.
    const solo = { ...paidDefinition(), nodes: [{ ...pooled, candidates: [only] }] };
    return createEstimateTotal(snapshotResolver(CATALOG))(solo)._unsafeUnwrap();
  }

  it('reserves the MAX over candidates plus one classifier reserve, never the Σ', () => {
    const pooled = createEstimateTotal(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    const cheap = soloReserve('cheap/classifier');
    const wide = soloReserve('wide/pro');
    const max = larger(cheap, wide);
    // Exactly one candidate answers, so the pool's own legs contribute their MAX.
    // The remainder above that MAX is one classifier reserve — a positive amount,
    // and strictly less than a second answer leg would be.
    expect(pooled).toBeGreaterThan(max);
    expect(pooled).toBeLessThan(cheap + wide);
    expect(pooled - max).toBeGreaterThan(0n);
  });

  it('sizes a pooled candidate exactly as a direct pick minus the classifier cost', () => {
    // BILLING §Smart Model 8. Both arms price the SAME catalog and the SAME
    // prompt, and the per-candidate cap is the one the pool stamped, so the whole
    // difference between "in the pool" and "picked directly" must be the one
    // classifier reserve the pool buys.
    //
    // The delta is asserted against the reserve the ADMISSION side computed
    // independently, never against itself: `pooled - max` compared to
    // `max + (pooled - max)` is an identity over any three numbers, and it would
    // hold just as well if the estimator priced the reserve TWICE. Pinning the
    // independent figure is what makes a double-priced reserve fail here.
    const pooled = createEstimateTotal(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    const cheap = soloReserve('cheap/classifier');
    const wide = soloReserve('wide/pro');
    const max = larger(cheap, wide);
    expect(pooled - max).toBe(
      classifierWorstCaseNanoUsd(tokenPriced(CHEAP_CLASSIFIER), CANDIDATE_IDS)
    );
    // The literal, so a silent move in either the reserve formula or the
    // estimator's fold shows up as a number rather than as a passing identity:
    // 5,020 reserve characters at 3 chars/token = 1,674 input tokens at 2n, plus
    // the 2,048-token output cap at 3n. Provider legs only — a storage term
    // creeping into the classifier reserve would break this equality, which is
    // the other property it pins.
    expect(pooled - max).toBe(9492n);
    // And the classifier's leg is small next to an answer leg — it prices a
    // truncated context and a capped output, not a full turn.
    expect(pooled - max).toBeLessThan(max);
  });
});

describe('buildSmartModelTurn', () => {
  it('grows the classify → decide stage the routed slot consumes', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const build = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    const definition = build.definition;
    expect(definition.deadlineClass).toBe('text');
    expect(definition.hooks).toEqual(CHAT_TURN_HOOKS);
    const node = definition.nodes.at(-1);
    // The classifier is a node of its own, so it carries its own charge key and
    // the slot reads the decision envelope rather than the raw prompt.
    expect(definition.nodes.map((one) => one.id)).toEqual([
      CHAT_CLASSIFIER_NODE_ID,
      CHAT_DECISION_NODE_ID,
      CHAT_TURN_NODE_ID,
    ]);
    expect(
      definition.nodes.filter((one) => isTurnClassifierNode(one, definition.nodes))
    ).toHaveLength(1);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
      inputSchema: TURN_DECISION_SCHEMA_NAME,
    });
    // A routing hiccup skips the branch rather than killing a paid turn.
    expect(definition.nodes[0]).toMatchObject({ optional: true, onError: 'skip' });
    // The prompt names the candidates the model axis routes among.
    expect(build.classifier?.prompt).toContain('mid-model');
  });

  it('prices the pinned siblings on top of the slot, not the slot alone', () => {
    // The whole point of emitting the sibling as a node: admission prices the
    // definition, so a sibling the graph dropped would be a generation the hold
    // never covered. Both builds share one classifier and one slot, so the whole
    // difference is the sibling's own answer leg.
    const build = (siblings?: { readonly models: readonly string[] }): WorkflowDefinition => {
      const { nodes, constraints } = createTurnCompileRegistries(resolver);
      return buildSmartModelTurn({
        classifierModelId: 'cheap-model',
        candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
        ...(siblings === undefined ? {} : { siblings }),
        nodes,
        constraints,
      })._unsafeUnwrap().definition;
    };
    const estimate = createEstimateTotal(resolver);
    const slotOnly = estimate(build())._unsafeUnwrap();
    const mixed = estimate(build({ models: ['sibling-model'] }))._unsafeUnwrap();
    expect(mixed).toBeGreaterThan(slotOnly);
  });

  it('feeds a sibling the prompt, not the decision, when no effort axis is open', () => {
    // The decision envelope always carries a concrete effort, because its schema
    // needs one — sound only while nothing reads it on a turn that presented no
    // option. A sibling reading it would have that invented level applied at
    // execution, turning wire SILENCE into an instruction on a send that asked
    // for no reasoning. The slot still reads the decision: it is the model axis
    // that opened the stage.
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      siblings: { models: ['sibling-model'] },
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    const sibling = definition.nodes.find((node) => node.id === `${CHAT_TURN_NODE_ID}0`);
    expect(sibling?.type === 'modelCall' && sibling.in.node).not.toBe(CHAT_DECISION_NODE_ID);
    const slot = definition.nodes.find((node) => node.type === 'smartModel');
    expect(slot?.type === 'smartModel' && slot.in.node).toBe(CHAT_DECISION_NODE_ID);
  });

  it('leaves the slot and every sibling a sink, so settlement persists each answer', () => {
    // No reducer joins the answers: each originating node's output becomes its
    // own assistant message. A consumed answer would be a message that never
    // lands, so the property is asserted rather than assumed.
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      siblings: { models: ['sibling-model'] },
      slotPosition: 1,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    const answers = definition.nodes.filter(
      (node) =>
        node.type === 'smartModel' ||
        (node.type === 'modelCall' && !isTurnClassifierNode(node, definition.nodes))
    );
    // Selected order: the sibling was picked first, the slot second.
    expect(answers.map((node) => node.id)).toEqual([`${CHAT_TURN_NODE_ID}0`, CHAT_TURN_NODE_ID]);
    const consumed = new Set(
      definition.nodes.flatMap((node) => ('in' in node ? [node.in.node as string] : []))
    );
    expect(answers.filter((node) => consumed.has(node.id))).toEqual([]);
  });

  it('stays one node when the slot has nothing to classify', () => {
    // One candidate closes the model axis and no effort dimension is declared,
    // so no classifier reserve is held — and buying a call anyway would bill for
    // a question already answered.
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const build = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(build.definition.nodes).toHaveLength(1);
    expect(build.classifier).toBeUndefined();
  });

  it('compiles the same turn under the trial hooks when a policy is supplied', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      hooks: TRIAL_TURN_HOOKS,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    expect(definition.hooks).toEqual(TRIAL_TURN_HOOKS);
    expect(definition.nodes.at(-1)).toMatchObject({ type: 'smartModel' });
  });

  it('injects the answer output-token ceiling into the node params when defined', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    expect(definition.nodes.at(-1)).toMatchObject({
      type: 'smartModel',
      params: { maxOutputTokens: 512 },
    });
  });

  it('leaves the node params empty when no ceiling is derived', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    expect(definition.nodes.at(-1)).toMatchObject({ type: 'smartModel', params: {} });
  });

  it('stamps promptInputTokens on the node (admission-only, not in params)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      promptInputTokens: 250,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    const node = definition.nodes.at(-1);
    expect(node?.type === 'smartModel' && node.promptInputTokens).toBe(250);
    // The answer call params carry only the real output cap.
    expect(node).toMatchObject({ type: 'smartModel', params: { maxOutputTokens: 512 } });
  });

  it('stamps the explicit hard-off reasoning wire into the node params when reasoningOff is set', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      reasoningOff: true,
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    // The cap is untouched (plain-turn sizing; B = 0) — only the wire rides.
    expect(definition.nodes.at(-1)).toMatchObject({
      type: 'smartModel',
      params: { maxOutputTokens: 512, reasoning: { enabled: false } },
    });
  });

  it('refuses a candidate list naming an unexposed model with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'ghost-model' }],
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('carries a declared classify dimension set onto the node', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'mid-model' }],
      classify: { model: false, effort: true },
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    expect(definition.nodes.at(-1)).toMatchObject({
      type: 'smartModel',
      classify: { model: false, effort: true },
    });
  });
});

/** A reasoning-capable priced text descriptor (effort-native, full ladder). */
function reasoningDescriptor(
  id: string,
  inputPerToken: bigint,
  outputPerToken: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    reasoning: { supportedEfforts: null },
    limits: { contextLength },
    pricing: tokenPricingFixture({ input: inputPerToken, output: outputPerToken }),
  };
}

describe('the trial Smart Model arm carries a money-bounded wire cap', () => {
  // The SECOND ungated door. A trial turn is quota-gated and its definition is
  // deliberately unstamped, so while the fit skipped unstamped definitions this arm
  // took the physical ceiling with no money term — and unlike the single-model arm it
  // had no wire-cap pin at all, so a single-arm fix would have left it open and green.
  //
  // The menu comes from the REAL trial derivation rather than a hand-written one:
  // that derivation stamps each candidate with its own ceiling, so a pin over a
  // capless hand-written menu would exercise a shape no send produces and leave
  // the door it guards ungated a second time.
  //
  // Rates are realistic on purpose: at 2–3 nano per token the 1¢ ceiling buys the
  // whole context window, the money term never binds, and the pin would pass either
  // way. At 1,500 billable nano per output token it binds hard.
  const TRIAL_CEILING_NANO = 10_000_000n;
  const CONTEXT = 1_000_000;
  const candidate: ModelDescriptor = {
    ...descriptorFor('trial/candidate'),
    limits: { contextLength: CONTEXT },
    pricing: tokenPricingFixture({ input: 1000n, output: 1500n }),
  };
  const catalog = [candidate];
  const trialBudget: TurnBudget = {
    promptCharacterCount: 400,
    inputCharacterCount: 400,
    funding: { kind: 'free', spendableNanoUsd: TRIAL_CEILING_NANO },
  };
  const picked = buildTrialSmartModelCandidates({
    descriptors: catalog,
    nowMs: NOW_MS,
    promptCharacterCount: trialBudget.promptCharacterCount,
  });

  async function trialDefinition(): Promise<WorkflowDefinition> {
    const compiled = await compileSmartModelBuild(catalog, picked, {
      hooks: TRIAL_TURN_HOOKS,
      budget: trialBudget,
    });
    const build = compiled._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable trial smart-model turn');
    return build.definition;
  }

  /**
   * The PHYSICAL room this candidate has — its own completion cap and remaining
   * context, no money term — as the oracle the money-bounded cap is measured
   * against.
   */
  function physicalRoom(): number {
    const pricings = turnModelPricings([candidate.id], snapshotResolver(catalog));
    if (pricings === undefined) throw new Error('expected a priceable candidate');
    const room = sharedAnswerCeiling(trialBudget, pricings);
    if (room === undefined) throw new Error('expected a physical room');
    return room;
  }

  /** The wire cap the slot will run this candidate at — its own, not the node's. */
  function candidateCap(definition: WorkflowDefinition): number {
    const node = definition.nodes.at(-1);
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    const cap = node.candidates[0]?.maxOutputTokens;
    if (typeof cap !== 'number') throw new Error('expected a per-candidate cap');
    return cap;
  }

  /** The definition re-capped at `tokens`, priced by the canonical estimator. */
  async function pricedAt(tokens: number): Promise<bigint> {
    const definition = await trialDefinition();
    return createEstimateTotal(snapshotResolver(catalog))({
      ...definition,
      nodes: definition.nodes.map((one) =>
        one.type === 'smartModel'
          ? {
              ...one,
              candidates: one.candidates.map((entry) => ({ ...entry, maxOutputTokens: tokens })),
            }
          : one
      ),
    })._unsafeUnwrap();
  }

  it('leaves the definition unstamped, so nothing it prices carries storage', async () => {
    const definition = await trialDefinition();
    expect(definition.storage).toBeUndefined();
  });

  it('prices the whole node within the per-message ceiling', async () => {
    const definition = await trialDefinition();
    const priced = createEstimateTotal(snapshotResolver(catalog))(definition)._unsafeUnwrap();
    expect(priced).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
  });

  it('shrinks the cap below the physical room, which is what a money term means here', async () => {
    const definition = await trialDefinition();
    const room = physicalRoom();
    // 400 chars at 3 chars/token = 134 input tokens, so the physical room is
    // 999,866 tokens — and the 1¢ ceiling buys far fewer.
    expect(room).toBe(999_866);
    expect(candidateCap(definition)).toBeLessThan(room);
  });

  it('deflates the trial cost circuit with the cap, because the circuit is estimate x 5', async () => {
    // The circuit limit is `estimate × COST_CIRCUIT_MULTIPLIER`, so it inherited the
    // cap's inflation and has to be shown to have followed the cap back down rather
    // than assumed to have. Bounded now at 5× the per-message ceiling; at the physical
    // room — the cap this arm carried while the fit skipped unstamped turns — the same
    // circuit sat more than 100× higher.
    const definition = await trialDefinition();
    const priced = createEstimateTotal(snapshotResolver(catalog))(definition)._unsafeUnwrap();
    expect(priced * COST_CIRCUIT_MULTIPLIER).toBeLessThanOrEqual(
      TRIAL_CEILING_NANO * COST_CIRCUIT_MULTIPLIER
    );
    const beforeLimit = (await pricedAt(physicalRoom())) * COST_CIRCUIT_MULTIPLIER;
    expect(beforeLimit).toBeGreaterThan(TRIAL_CEILING_NANO * COST_CIRCUIT_MULTIPLIER * 100n);
  });

  it('is the LARGEST cap the ceiling admits, so the fit is maximal and not merely safe', async () => {
    // The oracle is maximality, derived from the estimator itself rather than copied
    // from whatever the code emitted: one token more must not fit.
    const cap = candidateCap(await trialDefinition());
    expect(await pricedAt(cap)).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
    expect(await pricedAt(cap + 1)).toBeGreaterThan(TRIAL_CEILING_NANO);
  });
});

describe('compileAutoEffortTurn (pinned model + auto effort)', () => {
  const pinned = reasoningDescriptor('pinned-model', 2n, 3n, 400_000);
  const cheapText = {
    ...descriptorFor('cheap-model'),
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
  };
  const budget = {
    promptCharacterCount: 40,
    inputCharacterCount: 40,
    funding: { kind: 'purchased' as const, spendableNanoUsd: nanoUSD(10_000_000_000n) },
  };

  /** The built definition, or a thrown failure naming the unexpected outcome. */
  function builtDefinition(
    catalog: readonly ModelDescriptor[],
    model: string,
    turnBudget: TurnBudget
  ): WorkflowDefinition {
    const build = compileAutoEffortTurn(catalog, model, {
      budget: turnBudget,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(NOW_MS),
    })._unsafeUnwrap();
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    return build.definition;
  }

  it('builds a single-candidate smartModel node with the effort dimension and a concrete B+H cap', () => {
    const definition = builtDefinition([pinned, cheapText], 'pinned-model', budget);
    const node = definition.nodes.at(-1);
    // Three nodes: the effort axis is open, so the pinned+auto slot buys the same
    // classifier call every other classifying shape does.
    expect(definition.nodes).toHaveLength(3);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'pinned-model' }],
      classify: { model: false, effort: true },
    });
    // The completion cap is concrete (B + H for the strongest affordable
    // option): the runtime carves the classified level's budget out of it,
    // never past it.
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(REASONING_BUDGET_TOKENS_BY_EFFORT.max);
    // Persisting paid turn: storage-stamped, prompt tokens stamped.
    expect(definition.storage).toEqual({ inputChars: 40 });
    expect(node?.type === 'smartModel' && node.promptInputTokens).toBeGreaterThan(0);
    expect(definition.hooks).toEqual(CHAT_TURN_HOOKS);
  });

  it('walks the model’s own offered budgets, not a fixed level list', () => {
    // A context this tight clamps every rung from Low upward to the whole
    // window, so none of them leaves answer headroom; Lite's 2048 is the only
    // budget that still fits. Walking the model's real options finds it — a
    // walk over a fixed High/Medium/Low list sees only the clamped rungs and
    // abandons the turn to the fallback path.
    const tight = reasoningDescriptor('tight-context-model', 2n, 3n, 3400);
    const definition = builtDefinition([tight, cheapText], 'tight-context-model', budget);
    const node = definition.nodes.at(-1);
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(cap as number).toBeGreaterThanOrEqual(REASONING_BUDGET_TOKENS_BY_EFFORT.lite);
  });

  it('admission prices the built definition within the payer budget (fitted cap)', () => {
    const definition = builtDefinition([pinned, cheapText], 'pinned-model', budget);
    const estimate = createEstimateTotal(snapshotResolver([pinned, cheapText]));
    const priced = estimate(definition)._unsafeUnwrap();
    expect(priced <= payerSpendableNanoUsd(budget)).toBe(true);
  });

  it('carries the pinned model description onto its candidate entry', () => {
    const described = { ...pinned, id: 'described-model', description: 'thinks hard' };
    const definition = builtDefinition([described, cheapText], 'described-model', budget);
    const node = definition.nodes.at(-1);
    expect(node?.type === 'smartModel' && node.candidates[0]?.description).toBe('thinks hard');
  });

  it('falls back when the pinned model has no context length (no pricing basis for the cap)', () => {
    const capless = { ...pinned, id: 'capless-model', limits: {} };
    expect(
      compileAutoEffortTurn([capless, cheapText], 'capless-model', {
        budget: budget,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back for a single-level mandatory model (empty offered ladder — no choice exists)', () => {
    // Auto on a single-level mandatory model offers nothing to choose, so the
    // classifier stage honestly declines and the regular path runs it at the
    // provider default within H.
    const mandatory = {
      ...pinned,
      id: 'mandatory-model',
      reasoning: { supportedEfforts: ['only'], mandatory: true },
    };
    expect(
      compileAutoEffortTurn([mandatory, cheapText], 'mandatory-model', {
        budget: budget,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back on a Min-only model (one real choice — no classifier, no reserve)', () => {
    // Exactly one option (Min) ⇒ the deterministic pick belongs to the regular
    // path; building a classifier here would charge for a settled question.
    const minOnly = { ...pinned, id: 'min-only', reasoning: { supportedEfforts: ['none'] } };
    expect(
      compileAutoEffortTurn([minOnly, cheapText], 'min-only', {
        budget: budget,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back for a non-reasoning pinned model (regular path owns it)', () => {
    const plain = { ...descriptorFor('plain-model') };
    expect(
      compileAutoEffortTurn([plain, cheapText], 'plain-model', {
        budget: budget,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back for a model unknown to the catalog', () => {
    expect(
      compileAutoEffortTurn([cheapText], 'ghost-model', {
        budget: budget,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({
      kind: 'fallback',
    });
  });

  it('refuses with the typed classifier code when no classifier can be priced', () => {
    // BILLING §Effort 5/8d: no priceable engine ⇒ a typed refusal, never a
    // silent static pick; explicit levels stay usable.
    const rateless = {
      ...pinned,
      id: 'rateless-model',
      pricing: perImagePricingFixture({ anchor: 1n, dearest: 1n }),
    };
    const error = compileAutoEffortTurn([rateless], 'rateless-model', {
      budget: budget,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(NOW_MS),
    })._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('reports a budget that cannot fund the minimum classified turn as unaffordable', () => {
    // Free funding carries no cushion, so a 1-nano budget affords no level. The
    // outcome is distinct from `fallback`: nothing about the turn is settled, the
    // money simply is not there — and no gate downstream of the compile catches
    // it, because the fallback turn is the cheaper one, so the two arms have to
    // be told apart here.
    const broke = {
      promptCharacterCount: 40,
      inputCharacterCount: 40,
      funding: { kind: 'free' as const, spendableNanoUsd: nanoUSD(1n) },
    };
    expect(
      compileAutoEffortTurn([pinned, cheapText], 'pinned-model', {
        budget: broke,
        hooks: CHAT_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap()
    ).toEqual({ kind: 'unaffordable' });
  });
});

describe('an auto turn on a model that cannot turn reasoning off is refused below its cheapest rung', () => {
  /** GPT-5.4 Pro's catalog row: mandatory reasoning over a three-word ladder. */
  const pro: ModelDescriptor = {
    ...descriptorFor('openai/gpt-5.4-pro'),
    inputs: ['text', 'image'],
    limits: { contextLength: 1_050_000, maxOutputTokens: 128_000 },
    pricing: tokenPricingFixture({ input: 34_500n, output: 207_000n }),
    reasoning: {
      mandatory: true,
      defaultEffort: 'medium',
      supportedEfforts: ['xhigh', 'high', 'medium'],
    },
  };
  const engine = priced('cheap/engine', 52n, 161n, 131_072);
  const catalog: readonly ModelDescriptor[] = [pro, engine];
  const ONE_CENT = 10_000_000n;

  /** A 1,756-character prompt on a purchased balance of `spendable`. */
  function budgetOf(spendable: bigint): TurnBudget {
    return {
      promptCharacterCount: 1756,
      inputCharacterCount: 1756,
      funding: { kind: 'purchased', spendableNanoUsd: nanoUSD(spendable) },
    };
  }

  function composerFunds(spendable: bigint): boolean {
    return availableRungsOf(browserMenu(catalog, pro.id, budgetOf(spendable), 'paid')).length > 0;
  }

  function serverKind(spendable: bigint): AutoEffortTurnBuild['kind'] {
    return compileAutoEffortTurn(catalog, pro.id, {
      budget: budgetOf(spendable),
      hooks: CHAT_TURN_HOOKS,
      now: new Date(NOW_MS),
    })._unsafeUnwrap().kind;
  }

  /** The least whole-cent balance at which the composer funds a rung, by bisection. */
  function composerThreshold(): bigint {
    let unfunded = 51n * ONE_CENT;
    let funded = 100n * ONE_USD;
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

describe('the pinned-model auto build offers the classifier its own menu', () => {
  /** Sonnet 4.6's rates and ladder: a four-word vocabulary that can switch reasoning off. */
  const sonnet: ModelDescriptor = {
    ...descriptorFor('vendor/sonnet'),
    limits: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
    pricing: tokenPricingFixture({ input: 3450n, output: 17_250n }),
    reasoning: { supportedEfforts: ['max', 'high', 'medium', 'low'] },
  };
  /** The cheapest row, so it runs the classifier. */
  const engine = priced('cheap/engine', 52n, 161n, 131_072);
  const catalog: readonly ModelDescriptor[] = [sonnet, engine];

  /** A 10,000-token prompt at 3 characters per token. */
  function paidBudget(spendableNanoUsd: bigint): TurnBudget {
    return {
      promptCharacterCount: 30_000,
      inputCharacterCount: 1000,
      funding: { kind: 'purchased', spendableNanoUsd: nanoUSD(spendableNanoUsd) },
    };
  }

  function compiled(turnBudget: TurnBudget): MultiModelTurnBuild {
    const build = compileAutoEffortTurn(catalog, sonnet.id, {
      budget: turnBudget,
      hooks: CHAT_TURN_HOOKS,
      now: new Date(NOW_MS),
    })._unsafeUnwrap();
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    return build;
  }

  function browser(turnBudget: TurnBudget): ReturnType<typeof getTurnOptions> {
    return browserMenu(catalog, sonnet.id, turnBudget, 'paid');
  }

  it('offers Min and Low at $0.26, the rungs the browser marks available', () => {
    const turnBudget = paidBudget(260_000_000n);
    expect(compiled(turnBudget).classifier?.decisionDomain.presentedEfforts).toEqual([
      'off',
      'low',
    ]);
    expect(availableRungsOf(browser(turnBudget))).toEqual(['off', 'low']);
  });

  it('leaves a minimum answer under the cap at every rung the classifier can decide', () => {
    const build = compiled(paidBudget(260_000_000n));
    const cap = answerCapOf(build.definition);
    for (const rung of build.classifier?.decisionDomain.presentedEfforts ?? []) {
      const budgetTokens = rung === 'off' ? 0 : REASONING_BUDGET_TOKENS_BY_EFFORT.low;
      expect(cap - budgetTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    }
  });

  it('buys no classifier call at $0.11, where only Min is fundable', () => {
    const turnBudget = paidBudget(110_000_000n);
    const build = compiled(turnBudget);
    expect(availableRungsOf(browser(turnBudget))).toEqual(['off']);
    expect(build.classifier).toBeUndefined();
    expect(
      build.definition.nodes.some((node) => isTurnClassifierNode(node, build.definition.nodes))
    ).toBe(false);
  });

  it('runs Min at $0.11 with the reasoning switched off', () => {
    const answer = compiled(paidBudget(110_000_000n)).definition.nodes.find(
      (node) => node.type === 'modelCall'
    );
    expect(answer?.type === 'modelCall' ? answer.params['reasoning'] : undefined).toEqual(
      REASONING_OFF_WIRE
    );
  });

  it('holds at $0.11 exactly what the browser holds', () => {
    const turnBudget = paidBudget(110_000_000n);
    const held = browser(turnBudget).holdNanoUsd;
    if (held === undefined) throw new Error('expected a sendable turn');
    expect(
      createEstimateTotal(snapshotResolver(catalog))(
        compiled(turnBudget).definition
      )._unsafeUnwrap()
    ).toBe(BigInt(held));
  });

  it('holds what the browser holds at every one-rung balance from $0.055 to $0.130', () => {
    const estimate = createEstimateTotal(snapshotResolver(catalog));
    let compared = 0;
    for (let mills = 55n; mills <= 130n; mills += 1n) {
      const turnBudget = paidBudget(mills * 1_000_000n);
      const options = browser(turnBudget);
      if (availableRungsOf(options).length !== 1 || options.holdNanoUsd === undefined) continue;
      expect(estimate(compiled(turnBudget).definition)._unsafeUnwrap()).toBe(
        BigInt(options.holdNanoUsd)
      );
      compared += 1;
    }
    expect(compared).toBe(76);
  });

  describe('on the trial policy, at the fixed 1¢ ceiling', () => {
    const trialEngine = reasoningDescriptor('trial/engine', 1n, 1n, 1_000_000);
    const answerAt = (outputPerToken: bigint): ModelDescriptor =>
      reasoningDescriptor('trial/answer', 2n, outputPerToken, 1_000_000);
    const trialBudget: TurnBudget = {
      promptCharacterCount: 40,
      inputCharacterCount: 40,
      funding: { kind: 'free', spendableNanoUsd: nanoUSD(10_000_000n) },
    };

    function compileTrialAt(outputPerToken: bigint): AutoEffortTurnBuild {
      return compileAutoEffortTurn([answerAt(outputPerToken), trialEngine], 'trial/answer', {
        budget: trialBudget,
        hooks: TRIAL_TURN_HOOKS,
        now: new Date(NOW_MS),
      })._unsafeUnwrap();
    }

    function trialBrowser(outputPerToken: bigint): ReturnType<typeof getTurnOptions> {
      return browserMenu(
        [answerAt(outputPerToken), trialEngine],
        'trial/answer',
        trialBudget,
        'trial'
      );
    }

    it('offers the classifier only the rungs the trial menu marks available', () => {
      const build = compileTrialAt(3000n);
      if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
      expect(availableRungsOf(trialBrowser(3000n))).toEqual(['off', 'lite']);
      expect(build.classifier?.decisionDomain.presentedEfforts).toEqual(['off', 'lite']);
    });

    it('settles a trial menu that marks one rung and holds what the browser holds', () => {
      const build = compileTrialAt(4000n);
      if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
      const held = trialBrowser(4000n).holdNanoUsd;
      if (held === undefined) throw new Error('expected a sendable turn');
      expect(availableRungsOf(trialBrowser(4000n))).toEqual(['off']);
      expect(build.classifier).toBeUndefined();
      expect(
        createEstimateTotal(snapshotResolver([answerAt(4000n), trialEngine]))(
          build.definition
        )._unsafeUnwrap()
      ).toBe(BigInt(held));
    });

    it('holds what the browser holds at every one-rung prompt length', () => {
      const catalogAt = [answerAt(4000n), trialEngine];
      const estimate = createEstimateTotal(snapshotResolver(catalogAt));
      let compared = 0;
      for (let chars = 0; chars <= 2000; chars += 10) {
        const promptBudget: TurnBudget = {
          ...trialBudget,
          promptCharacterCount: chars,
          inputCharacterCount: chars,
        };
        const options = browserMenu(catalogAt, 'trial/answer', promptBudget, 'trial');
        if (availableRungsOf(options).length !== 1 || options.holdNanoUsd === undefined) continue;
        const build = compileAutoEffortTurn(catalogAt, 'trial/answer', {
          budget: promptBudget,
          hooks: TRIAL_TURN_HOOKS,
          now: new Date(NOW_MS),
        })._unsafeUnwrap();
        if (build.kind !== 'built') throw new Error(`expected a built turn at ${String(chars)}`);
        expect(estimate(build.definition)._unsafeUnwrap()).toBe(BigInt(options.holdNanoUsd));
        compared += 1;
      }
      expect(compared).toBe(201);
    });

    it('refuses a trial send whose menu marks no rung', () => {
      expect(availableRungsOf(trialBrowser(5000n))).toEqual([]);
      expect(compileTrialAt(5000n)).toEqual({ kind: 'unaffordable' });
    });
  });
});

/** The browser's own option set for a one-model tool-free auto turn over `catalog`. */
function browserMenu(
  catalog: readonly ModelDescriptor[],
  model: string,
  turnBudget: TurnBudget,
  tier: UserTier
): ReturnType<typeof getTurnOptions> {
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(turnBudget.funding.spendableNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: tier,
      payer: 'self',
    },
    promptBasisFromTotal({
      promptChars: turnBudget.promptCharacterCount,
      inputChars: turnBudget.inputCharacterCount,
    }),
    {
      answerSources: { models: [modelId(model)], smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models: smartModelPool(catalog), nowMs: NOW_MS }
  );
}

/** The rungs an option set marks available, ascending. */
function availableRungsOf(options: ReturnType<typeof getTurnOptions>): readonly string[] {
  return options.admissible.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

/** The one answer cap a definition's answer node carries. */
function answerCapOf(definition: WorkflowDefinition): number {
  const node = definition.nodes.at(-1);
  const cap =
    node?.type === 'smartModel' || node?.type === 'modelCall'
      ? node.params['maxOutputTokens']
      : undefined;
  if (typeof cap !== 'number') throw new Error('expected an answer cap');
  return cap;
}

describe('compileAutoEffortTurn on the trial policy', () => {
  // A trial turn runs the SAME pinned+auto compiler as a paid one — §Reasoning
  // Effort 5 forbids a static fallback on any tier — under the no-persist,
  // no-charge policy and against the fixed per-message ceiling that stands in
  // for a wallet (§Trial Usage).
  const TRIAL_CEILING_NANO = 10_000_000n;
  const budget: TurnBudget = {
    promptCharacterCount: 40,
    inputCharacterCount: 40,
    funding: { kind: 'free', spendableNanoUsd: nanoUSD(TRIAL_CEILING_NANO) },
  };
  /** The 1¢ ceiling covers a minimum answer at these rates but not the reserve too. */
  const dearOutput = reasoningDescriptor('trial/dear-output', 1000n, 3000n, 1_000_000);
  /** Cheap enough that the classified turn fits, so the priced shape is inspectable. */
  const cheap = reasoningDescriptor('trial/cheap', 2n, 3n, 1_000_000);

  function compileTrial(catalog: readonly ModelDescriptor[], model: string): AutoEffortTurnBuild {
    return compileAutoEffortTurn(catalog, model, {
      budget: budget,
      hooks: TRIAL_TURN_HOOKS,
      now: new Date(NOW_MS),
    })._unsafeUnwrap();
  }

  it('reports a model whose classifier reserve overruns the ceiling as unaffordable', () => {
    // The model is the only priceable row, so it is also the classifier engine and
    // the reserve is priced at its own rates. The companion below shows the answer
    // alone fits the same ceiling, so it is the reserve that decides this.
    expect(compileTrial([dearOutput], 'trial/dear-output')).toEqual({ kind: 'unaffordable' });
  });

  it('admits the same rates once the classifier is not bought', () => {
    // The reserve-free half of the pair: a smartModel slot with no active
    // dimension prices no reserve, and the minimum answer at those rates is
    // inside the ceiling — so the refusal above is the reserve, not the answer.
    const registries = createTurnCompileRegistries(snapshotResolver([dearOutput]));
    const reserveFree = buildSmartModelTurn({
      classifierModelId: dearOutput.id,
      candidates: [{ id: dearOutput.id }],
      classify: { model: false, effort: false },
      answerCapTokens: MINIMUM_OUTPUT_TOKENS,
      promptInputTokens: promptInputTokensFor(budget),
      hooks: TRIAL_TURN_HOOKS,
      nodes: registries.nodes,
      constraints: registries.constraints,
    })._unsafeUnwrap().definition;
    const priced = createEstimateTotal(snapshotResolver([dearOutput]))(reserveFree)._unsafeUnwrap();
    expect(priced).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
  });

  it('carries the trial policy hooks onto the classified definition', () => {
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.hooks).toEqual(TRIAL_TURN_HOOKS);
  });

  it('leaves the classified trial definition unstamped, so no storage is held', () => {
    // A trial turn persists nothing, so stamping it would reserve storage that
    // settlement can never bill — the whole reason the hooks are a parameter
    // rather than the paid policy this compiler used to hardcode.
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.storage).toBeUndefined();
  });

  it('opens the effort dimension on the single-candidate slot', () => {
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.nodes.at(-1)).toMatchObject({
      type: 'smartModel',
      candidates: [{ id: 'trial/cheap' }],
      classify: { model: false, effort: true },
    });
  });

  it('prices the classifier reserve into the admission estimate', () => {
    // Deactivating the one declared dimension is the only difference between the
    // two prices, so the delta IS the reserve — measured against the shared
    // reserve producer rather than against a number copied out of the estimator.
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    const estimate = createEstimateTotal(snapshotResolver([cheap]));
    // Dropping the classifier NODE is what removes the classifier: the reserve is
    // held for a call that exists on the graph, not for a flag on the slot.
    const withoutClassifier = {
      ...build.definition,
      nodes: build.definition.nodes.filter((node) => node.type === 'smartModel'),
    };
    const reserve = classifierWorstCaseNanoUsd(tokenPriced(cheap), []);
    expect(reserve).toBeGreaterThan(0n);
    expect(
      estimate(build.definition)._unsafeUnwrap() - estimate(withoutClassifier)._unsafeUnwrap()
    ).toBe(reserve);
  });

  // The compiler's outcomes, ordered along ONE axis: the ceiling, the prompt,
  // the ladder and the classifier engine are held fixed and only the answer
  // model's output rate moves, so an outcome is set by the menu that rate buys
  // and never by one of the compiler's earlier exits (they are rate-independent).
  describe('the build follows the menu the ceiling buys', () => {
    /** The cheapest priceable row, so the classifier engine is the same one in all four. */
    const engine = reasoningDescriptor('trial/engine', 1n, 1n, 1_000_000);
    /** One answer model priced four ways; every other input is held fixed. */
    const answerAt = (outputPerToken: bigint): ModelDescriptor =>
      reasoningDescriptor('trial/answer', 2n, outputPerToken, 1_000_000);

    it('runs Min with no classifier once the ceiling funds Min alone', () => {
      // A cap short of the cheapest rung's budget plus a minimum answer funds
      // Min and nothing above it, so the one available rung settles the turn:
      // no rung is offered that would run with less than a minimum answer.
      const build = compileTrial([answerAt(4000n), engine], 'trial/answer');
      if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
      expect(build.classifier).toBeUndefined();
      const node = build.definition.nodes.at(-1);
      expect(node?.type === 'modelCall' ? node.params['reasoning'] : undefined).toEqual(
        REASONING_OFF_WIRE
      );
      expect(
        node?.type === 'modelCall' ? node.params['maxOutputTokens'] : 0
      ).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    });

    it('hands the same rate to the regular path once the ladder is gone', () => {
      // What separates the build above from a plain unclassified turn: at this
      // very rate a model with no ladder to classify leaves the classifier
      // nothing to decide, so it is handed to the regular path instead of
      // compiling a classified slot.
      const ladderless = { ...answerAt(4000n), reasoning: undefined };
      expect(compileTrial([ladderless, engine], 'trial/answer')).toEqual({ kind: 'fallback' });
    });

    it('builds the classified turn once the fitted cap covers the cheapest rung', () => {
      const build = compileTrial([answerAt(3000n), engine], 'trial/answer');
      if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
      const node = build.definition.nodes.at(-1);
      const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
      expect(cap as number).toBeGreaterThanOrEqual(
        REASONING_BUDGET_TOKENS_BY_EFFORT.lite + MINIMUM_OUTPUT_TOKENS
      );
    });

    it('reports unaffordable when the cap cannot reach the minimum answer', () => {
      expect(compileTrial([answerAt(10_000n), engine], 'trial/answer')).toEqual({
        kind: 'unaffordable',
      });
    });
  });
});

/** Two rungs the slot's menu marks available, as the producer publishes them. */
const TWO_AVAILABLE_RUNGS: SmartModelCandidates['effortOptions'] = [
  { optionId: 'lite', label: 'Lite' },
  { optionId: 'low', label: 'Low' },
];

describe('effortDimensionForCandidates (Smart Model + auto gate)', () => {
  const pinned = reasoningDescriptor('reasoner', 2n, 3n, 100_000);
  const plain = descriptorFor('plain');

  function pickedWith(
    candidates: SmartModelCandidates['candidates'],
    effortOptions: SmartModelCandidates['effortOptions']
  ): SmartModelCandidates {
    return { classifierModelId: 'plain', candidates, effortOptions };
  }

  it('returns the both-dimensions classify set when the pool presents two or more effort rungs', () => {
    expect(
      effortDimensionForCandidates(
        [plain, pinned],
        pickedWith([{ id: 'plain' }, { id: 'reasoner' }], TWO_AVAILABLE_RUNGS)
      )
    ).toEqual({ model: true, effort: true });
  });

  it('returns undefined when the pool presents NO effort rungs (no call, no charge, no reserve)', () => {
    expect(
      effortDimensionForCandidates([plain], pickedWith([{ id: 'plain' }], []))
    ).toBeUndefined();
  });

  it('closes the effort axis when the slot’s menu marks no rung available', () => {
    expect(
      effortDimensionForCandidates(
        [plain, pinned],
        pickedWith([{ id: 'plain' }, { id: 'reasoner' }], [])
      )
    ).toBeUndefined();
  });
});

describe('the slot’s classifier and its siblings’ loop follow the slot’s own menu', () => {
  const engine = priced('aaa/engine', 1n, 2n, 100_000);
  const reasoner = {
    ...reasoningDescriptor('bbb/reasoner', 2n, 3n, 100_000),
    behaviors: ['tools'],
  };
  const sibling = { ...reasoningDescriptor('ccc/sibling', 4n, 6n, 100_000), behaviors: ['tools'] };
  const catalog: readonly ModelDescriptor[] = [engine, reasoner, sibling];
  const picked: SmartModelCandidates = {
    classifierModelId: engine.id,
    candidates: [{ id: engine.id }, { id: reasoner.id }],
    effortOptions: TWO_AVAILABLE_RUNGS,
    toolLoopEffort: 'low',
  };

  async function compiled(
    options: Parameters<typeof compileSmartModelBuild>[2]
  ): Promise<MultiModelTurnBuild> {
    const compiledBuild = await compileSmartModelBuild(catalog, picked, options);
    const build = compiledBuild._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable smart-model turn');
    return build;
  }

  function searchingSiblings(): ReturnType<typeof turnSiblings> {
    return turnSiblings(catalog, [sibling.id], { classifyEffort: true, webSearchEnabled: true });
  }

  it('offers the slot’s classifier exactly the rungs its menu marks available', async () => {
    const build = await compiled({ classify: { model: true, effort: true } });
    expect(build.classifier?.decisionDomain.presentedEfforts).toEqual(['lite', 'low']);
  });

  it('declares the searching siblings’ loop at the rung the menu’s loop effort names', async () => {
    const build = await compiled({
      classify: { model: true, effort: true },
      siblings: searchingSiblings()._unsafeUnwrap(),
    });
    const node = build.definition.nodes.find((candidate) => candidate.id === multiModelNodeId(0));
    expect(node?.type === 'modelCall' ? node.maxSteps : undefined).toBe(
      toolLoopStepsFor(toolCallCapFor('low'))
    );
  });

  it('declares the searching siblings’ loop at the rung the send pins', async () => {
    const budget: TurnBudget = {
      promptCharacterCount: 400,
      inputCharacterCount: 400,
      funding: { kind: 'purchased', spendableNanoUsd: ONE_USD },
    };
    const build = await compiled({
      pinnedEffort: 'high',
      budget,
      siblings: turnSiblings(catalog, [sibling.id], {
        budget,
        pinnedEffort: 'high',
        webSearchEnabled: true,
      })._unsafeUnwrap(),
    });
    const node = build.definition.nodes.find((candidate) => candidate.id === multiModelNodeId(0));
    expect(node?.type === 'modelCall' ? node.maxSteps : undefined).toBe(
      toolLoopStepsFor(toolCallCapFor('high'))
    );
  });
});

describe('an auto send whose whole option set is settled buys no classifier', () => {
  // A mandatory-reasoning model with a single native word offers exactly ONE
  // rung (§Reasoning Effort 2), and one candidate closes the model axis — so
  // both axes are settled and §Reasoning Effort 5 / 10(c) forbid the call and
  // the reserve alike.
  const oneRung: ModelDescriptor = {
    ...reasoningDescriptor('mandatory/one-rung', 2n, 3n, 100_000),
    reasoning: { supportedEfforts: ['only'], mandatory: true },
  };
  const engine = reasoningDescriptor('cheap/engine', 1n, 1n, 100_000);
  const catalog = [oneRung, engine];
  const picked: SmartModelCandidates = {
    classifierModelId: engine.id,
    candidates: [{ id: oneRung.id }],
    effortOptions: [],
  };

  /** The compile the send path performs, over a supplied classify set. */
  async function compiledWith(
    classify: { readonly model: boolean; readonly effort: boolean } | undefined
  ): Promise<MultiModelTurnBuild> {
    const compiled = await compileSmartModelBuild(
      catalog,
      picked,
      classify === undefined ? {} : { classify }
    );
    const build = compiled._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable smart-model turn');
    return build;
  }

  /** The auto send end to end: the gate's answer, compiled. */
  function autoSend(): Promise<MultiModelTurnBuild> {
    return compiledWith(effortDimensionForCandidates(catalog, picked));
  }

  it('declares no effort dimension for a lone single-rung candidate', () => {
    expect(effortDimensionForCandidates(catalog, picked)).toBeUndefined();
  });

  it('compiles the slot alone, with no classifier node to charge', async () => {
    const build = await autoSend();
    expect(build.definition.nodes.map((node) => node.id)).toEqual([CHAT_TURN_NODE_ID]);
    expect(build.classifier).toBeUndefined();
  });

  it('holds no classifier reserve, unlike the same slot with the axis forced open', async () => {
    const estimate = createEstimateTotal(snapshotResolver(catalog));
    const settled = await autoSend();
    const forced = await compiledWith({ model: false, effort: true });
    expect(estimate(settled.definition)._unsafeUnwrap()).toBeLessThan(
      estimate(forced.definition)._unsafeUnwrap()
    );
  });
});

describe('free-tier Smart admission: storage-folded per-candidate caps fit the daily allowance', () => {
  // A free-tier Smart Model turn persists, so each candidate's cap must cover the
  // answer/prompt STORAGE the estimator holds (5 stored characters per output
  // token — dominant over a cheap model's token rate). Folding storage into the per-candidate cap
  // is what keeps the reserve within the 50M daily allowance; without it the
  // full-context cap's storage alone blows the allowance and free users 402.
  const FREE_MODEL = 'free/smart';
  const CATALOG = [priced(FREE_MODEL, 2n, 3n, 128_000)];
  const DAILY_ALLOWANCE = 50_000_000n;
  const budget = {
    promptCharacterCount: 400,
    inputCharacterCount: 400,
    funding: { spendableNanoUsd: DAILY_ALLOWANCE, kind: 'free' as const },
  };
  /** The producer's own free-tier pick — storage rides the persisting turn, not an argument. */
  function freeCandidates(): NonNullable<ReturnType<typeof buildSmartModelCandidates>> {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: budget.funding.spendableNanoUsd,
      tier: 'free',
      promptChars: budget.promptCharacterCount,
      inputChars: budget.inputCharacterCount,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: NOW_MS,
    });
    if (picked === null) throw new Error('expected a buildable free-tier smart-model turn');
    return picked;
  }

  /** A definition over one candidate at whatever cap is handed in. */
  function definitionAtCap(maxOutputTokens: number | undefined): WorkflowDefinition {
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    const built = buildSmartModelTurn({
      classifierModelId: FREE_MODEL,
      candidates: [
        { id: FREE_MODEL, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
      ],
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap().definition;
    return withStorageStamp(built, budget, CHAT_TURN_HOOKS);
  }

  it('the storage-folded per-candidate cap keeps the reserve within the daily allowance', () => {
    const ceiling = createEstimateTotal(snapshotResolver(CATALOG))(
      definitionAtCap(freeCandidates().candidates[0]?.maxOutputTokens)
    )._unsafeUnwrap();
    expect(ceiling).toBeLessThanOrEqual(DAILY_ALLOWANCE);
  });

  it('a cap bounded by physics alone would over-reserve past the allowance', () => {
    // The counterfactual the fold exists to prevent: at 5 stored characters per
    // output token the stored answer costs more than the tokens do, so a cap set
    // by the model's own window blows the allowance. That the producer's cap sits
    // strictly under that window is the fold, and it is structural — storage
    // follows every persisting turn and is not a caller's argument to omit.
    const physicalCap = 128_000 - promptInputTokensFor(budget);
    expect(freeCandidates().candidates[0]?.maxOutputTokens).toBeLessThan(physicalCap);
    const ceiling = createEstimateTotal(snapshotResolver(CATALOG))(
      definitionAtCap(physicalCap)
    )._unsafeUnwrap();
    expect(ceiling).toBeGreaterThan(DAILY_ALLOWANCE);
  });
});

/**
 * The hold a Smart Model send actually places: the run estimator's figure over
 * the definition the turn compiles, which is exactly what the interpreter hands
 * the admission hook and the hook hands `admitRun`. Every case here reads that
 * one quantity. The candidate producer's own projection of "the hold" is a
 * second computation over a different set — the full priceable pool rather than
 * the eligible subset the node prices — so pinning that one would leave the
 * placed hold unmeasured.
 */
describe('the hold a Smart Model send places', () => {
  const HOLD_PROMPT_CHARS = 400;

  function budgetFor(tier: UserTier, spendableNanoUsd: bigint): TurnBudget {
    return {
      promptCharacterCount: HOLD_PROMPT_CHARS,
      inputCharacterCount: HOLD_PROMPT_CHARS,
      funding: { spendableNanoUsd, kind: tier === 'paid' ? 'purchased' : 'free' },
    };
  }

  /**
   * One send, from the payer's funding to the definition admission prices: the
   * shipped candidate derivation, sibling derivation and compile, in the
   * builder's own order — so a change to any of the three moves every figure
   * below, and the sibling capability gate refuses a search send pinning a
   * model that cannot carry the tool. No send here pins an effort or asks for
   * classification, so the slot's compile options reduce to the budget.
   */
  async function definitionFor(args: {
    readonly catalog: readonly ModelDescriptor[];
    readonly balanceNanoUsd: bigint;
    readonly tier: UserTier;
    readonly pinnedModelIds?: readonly string[];
    readonly webSearch?: boolean;
  }): Promise<WorkflowDefinition> {
    const { catalog, balanceNanoUsd, tier } = args;
    const pinnedModelIds = args.pinnedModelIds ?? [];
    const webSearch = args.webSearch ?? false;
    const budget = budgetFor(tier, balanceNanoUsd);
    const picked = buildSmartModelCandidates({
      descriptors: catalog,
      balanceNanoUsd,
      tier,
      promptChars: HOLD_PROMPT_CHARS,
      inputChars: HOLD_PROMPT_CHARS,
      pinnedModelIds,
      webSearch,
      nowMs: NOW_MS,
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    const compiled = await compileSmartModelBuild(catalog, picked, {
      budget,
      ...(pinnedModelIds.length === 0
        ? {}
        : {
            siblings: turnSiblings(catalog, pinnedModelIds, {
              budget,
              ...(webSearch ? { webSearchEnabled: true } : {}),
            })._unsafeUnwrap(),
          }),
    });
    const build = compiled._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable smart-model turn');
    return build.definition;
  }

  const holdOf = (catalog: readonly ModelDescriptor[], definition: WorkflowDefinition): bigint =>
    createEstimateTotal(snapshotResolver(catalog))(definition)._unsafeUnwrap();

  describe('graded by the payer’s own tier', () => {
    /**
     * The four-row control, wide enough on its own for premium classification to
     * resolve a price threshold (the minimum pool size is four).
     */
    const BASIC = [
      priced('cheap/model', 1n, 2n, 100_000),
      priced('mid/model', 10n, 20n, 100_000),
      priced('a/one', 2n, 4n, 100_000),
      priced('b/two', 3n, 6n, 100_000),
    ];
    /**
     * Premium on BOTH legs — a rate at the pool's 75th-percentile threshold AND
     * a release inside the recency window — so these cases discriminate neither,
     * and no reader should take them as evidence about one. Its 900k window is
     * what makes its arrangement the costliest the paid hold must cover, while
     * staying under the 20× median multiple that would make it an outlier and
     * drop it out of the classifier-selectable set altogether.
     */
    const PREMIUM = {
      ...priced('z/premium', 10n, 20n, 900_000),
      releasedAt: secondsAt(NOW_MS - DAY_MS),
    };
    const POOL = [...BASIC, PREMIUM];
    const HUGE_BALANCE = 10n ** 18n;

    const holdAt = async (catalog: readonly ModelDescriptor[], tier: UserTier): Promise<bigint> =>
      holdOf(catalog, await definitionFor({ catalog, balanceNanoUsd: HUGE_BALANCE, tier }));

    it('holds against the OFFERABLE set — a premium row moves the paid hold, not the free one', async () => {
      // THE pin against a tier-blind hold. A tier-blind one would price the
      // premium row for both payers and the two deltas would be equal. As it
      // stands the free payer cannot pick that row, so it reaches their hold at
      // most through the classifier prompt it is still named in, while for the
      // paid payer it moves the hold by its whole arrangement.
      const freeDelta = (await holdAt(POOL, 'free')) - (await holdAt(BASIC, 'free'));
      const paidDelta = (await holdAt(POOL, 'paid')) - (await holdAt(BASIC, 'paid'));
      expect(freeDelta * 1000n).toBeLessThan(paidDelta);
    });

    it('holds far below the tier-blind figure a free payer used to carry', async () => {
      expect((await holdAt(POOL, 'free')) * 4n).toBeLessThan(await holdAt(POOL, 'paid'));
    });
  });

  describe('the pinned siblings’ web-search reservation', () => {
    /**
     * Tool-capable rows: web search runs as a tool call, so a send pinning a
     * model without the capability is refused at build and never priced.
     */
    const searchable = (row: ModelDescriptor): ModelDescriptor => ({
      ...row,
      behaviors: [...row.behaviors, 'tools'],
    });
    const SLOT_ONLY_ROW = searchable(priced('aaa/model', 1n, 2n, 100_000));
    const FIRST_PINNED = searchable(priced('bbb/model', 10n, 20n, 100_000));
    const SECOND_PINNED = searchable(priced('ccc/model', 11n, 21n, 100_000));
    const CATALOG = [SLOT_ONLY_ROW, FIRST_PINNED, SECOND_PINNED];
    const BALANCE = 10n ** 15n;

    /**
     * What a paid search loop adds over the same compiled node answering in one
     * call, from first principles: ten more prompts, ten more steps of output
     * and its storage, the model's own output re-sent 55 answers' worth, each of
     * ten calls' results re-sent on ten later steps, the tool-use overhead on the
     * ten tool-carrying steps, ten call fees and the stored search rows. The
     * node's prompt and output ceiling are read off the send, and the window
     * bounds both, as it bounds the estimator's legs.
     */
    const loopExtraOf = (definition: WorkflowDefinition, row: ModelDescriptor): bigint => {
      const node = definition.nodes.find(
        (candidate) => candidate.type === 'modelCall' && candidate.model === row.id
      );
      if (node?.type !== 'modelCall') throw new Error(`expected a modelCall for ${row.id}`);
      const context = row.limits['contextLength'] ?? 0;
      const declared = node.params['maxOutputTokens'];
      const prompt = BigInt(Math.min(context, node.promptInputTokens ?? context));
      const ceiling = BigInt(Math.min(context, typeof declared === 'number' ? declared : context));
      const { input, output } = tokenPriced(row).pricing.anchor.base;
      const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
      const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
      return (
        10n * prompt * input +
        10n * ceiling * (output + 5n * 300n) +
        55n * ceiling * input +
        10n * 10n * resultTokens * input +
        10n * overheadTokens * input +
        10n * toolCallBillableNano('webSearch') +
        BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n
      );
    };

    const searchingSend = (pinnedModelIds: readonly string[]): Promise<WorkflowDefinition> =>
      definitionFor({
        catalog: CATALOG,
        balanceNanoUsd: BALANCE,
        tier: 'paid',
        pinnedModelIds,
        webSearch: true,
      });

    /**
     * The same compiled send with the tool taken off whichever nodes declare it,
     * and nothing else touched, so the difference is the loop alone. Comparing the
     * send to a separately compiled search-free one would also measure the
     * answer caps the two builds size differently.
     */
    const withoutSearchTool = (definition: WorkflowDefinition): WorkflowDefinition => ({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.type === 'modelCall' && node.tools.length > 0 ? { ...node, tools: [] } : node
      ),
    });

    it('reserves for one pinned sibling exactly once', async () => {
      const definition = await searchingSend([FIRST_PINNED.id]);
      expect(holdOf(CATALOG, definition) - holdOf(CATALOG, withoutSearchTool(definition))).toBe(
        loopExtraOf(definition, FIRST_PINNED)
      );
    });

    it('reserves once per pinned sibling', async () => {
      const definition = await searchingSend([FIRST_PINNED.id, SECOND_PINNED.id]);
      expect(holdOf(CATALOG, definition) - holdOf(CATALOG, withoutSearchTool(definition))).toBe(
        loopExtraOf(definition, FIRST_PINNED) + loopExtraOf(definition, SECOND_PINNED)
      );
    });
  });

  describe('a slot-only send reserves no web search at all', () => {
    /**
     * The counterpart miscount to the one above: counting the slot's own answer
     * as a tool carrier. It cannot show up in the estimator, whose `smartModel`
     * schema has no tools field to price, so it can only reach the hold through
     * the funding the candidate menu is graded against — which is why this
     * fixture is deliberately MONEY bound where the sibling cases are context
     * bound. A wide window at this balance leaves each candidate's cap set by
     * what the payer can afford, so a reservation taken for an answer that
     * cannot search shows up as a smaller cap and a smaller hold.
     */
    const WIDE_CONTEXT = 10_000_000;
    const CATALOG = [
      priced('aaa/model', 1n, 2n, WIDE_CONTEXT),
      priced('bbb/model', 10n, 20n, WIDE_CONTEXT),
    ];
    const BALANCE = 400_000_000n;

    it('places the identical hold with the search toggle on and off', async () => {
      const send = (webSearch: boolean): Promise<WorkflowDefinition> =>
        definitionFor({ catalog: CATALOG, balanceNanoUsd: BALANCE, tier: 'paid', webSearch });
      expect(holdOf(CATALOG, await send(true))).toBe(holdOf(CATALOG, await send(false)));
    });
  });
});
