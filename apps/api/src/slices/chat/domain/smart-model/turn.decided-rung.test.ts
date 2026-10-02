/**
 * A searching Auto turn with a Smart Model slot, run end to end: the classifier's
 * answer becomes one decision, and every node of the turn runs that one rung.
 *
 * The fixture is a pinned, searching Sonnet beside a slot whose pool holds an
 * engine, a mandatory-reasoning model, a ladderless model and an open-ladder
 * model, at a funding whose menu is Min and Lite. The dearer Lite loop leaves
 * the two mandatory-reasoning candidates a cap for Min alone, so an answer
 * binding either at Lite is the case the decision has to clamp. What each node ran is priced by the run
 * estimator and held to the turn's own hold.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  REASONING_EFFORT_LABELS,
  ResolvedReasoningEffort as RungSchema,
  TURN_DECISION_REDUCER,
  candidateAnsweringAt,
  isTurnClassifierNode,
  nanoUSD,
  textTag,
} from '@hushbox/shared';
import { toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { ok } from '../../../../lib/result/index.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  createLiveExecutionRegistry,
  createWorkflowExecutor,
  predicateCode,
  reducerCode,
} from '../../../workflows/index.js';
import { createEstimateRun, createToolRegistry } from '../../../models/index.js';
import {
  compileMultiModelTurnOutcome,
  createTurnCompileRegistries,
  turnInputs,
} from '../turn/definition.js';
import { compileSmartModelSend } from './turn.js';
import type {
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  ModelReasoning,
  Node,
  ResolvedReasoningEffort,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../../../models/index.js';
import type { TransformCompute } from '../../../media/index.js';
import type { ModelBinding, SubWorkflowBinding } from '../../../workflows/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { MultiModelTurnBuild, TurnBudget } from '../turn/definition.js';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { NanoUSD } from '@hushbox/shared';

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

const NOW_MS = TEST_DAY_START;
const CONTEXT_LENGTH = 200_000;

interface Row {
  readonly id: string;
  readonly input: bigint;
  readonly output: bigint;
  readonly cap: number;
  readonly reasoning?: ModelReasoning;
}

const SONNET: Row = {
  id: 'vendor/sonnet',
  input: 3450n,
  output: 17_250n,
  cap: 128_000,
  reasoning: { supportedEfforts: ['max', 'high', 'medium', 'low'] },
};
const ENGINE: Row = {
  id: 'vendor/engine',
  input: 52n,
  output: 161n,
  cap: 16_384,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};
const MANDATORY: Row = {
  id: 'vendor/mandatory',
  input: 1000n,
  output: 5000n,
  cap: 64_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};
const LADDERLESS: Row = { id: 'vendor/ladderless', input: 200n, output: 800n, cap: 16_000 };
const OPEN: Row = {
  id: 'vendor/open',
  input: 300n,
  output: 1200n,
  cap: 64_000,
  reasoning: { supportedEfforts: null },
};
const ROWS = [SONNET, ENGINE, MANDATORY, LADDERLESS, OPEN];

/** $0.71 spendable: the menu is Min and Lite. */
const FUNDING = 710_000_000n;

/** The candidates this funding leaves a cap for Min alone. */
const MIN_ONLY: ReadonlySet<string> = new Set([ENGINE.id, MANDATORY.id]);

function descriptorOf(row: Row): ModelDescriptor {
  return {
    id: row.id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming', 'tools'],
    limits: { contextLength: CONTEXT_LENGTH, maxOutputTokens: row.cap },
    pricing: tokenPricingFixture({ input: row.input, output: row.output }),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
  };
}

const CATALOG = ROWS.map((row) => descriptorOf(row));

function resolve(id: string): ModelDescriptor | undefined {
  return CATALOG.find((descriptor) => descriptor.id === id);
}

const BUDGET: TurnBudget = {
  promptCharacterCount: 1000,
  inputCharacterCount: 100,
  funding: { kind: 'purchased', spendableNanoUsd: nanoUSD(FUNDING) },
};

function budgetOf(funding: bigint, promptChars: number, tier: 'paid' | 'free'): TurnBudget {
  return {
    promptCharacterCount: promptChars,
    inputCharacterCount: Math.min(promptChars, 100),
    funding: { kind: tier === 'paid' ? 'purchased' : 'free', spendableNanoUsd: nanoUSD(funding) },
  };
}

/** A searching Auto send pinning `pinned` beside the Smart Model slot. */
async function slotSend(
  budget: TurnBudget,
  pinned: string = SONNET.id
): Promise<MultiModelTurnBuild | undefined> {
  const compiled = await compileSmartModelSend(CATALOG, {
    budget,
    classifyEffort: true,
    pinnedModels: [pinned],
    webSearchEnabled: true,
    balanceNanoUsd: budget.funding.spendableNanoUsd,
    nowMs: NOW_MS,
  });
  const build = compiled._unsafeUnwrap();
  return build.buildable ? build : undefined;
}

async function compiledTurn(): Promise<MultiModelTurnBuild> {
  const build = await slotSend(BUDGET);
  if (build === undefined) throw new Error('expected a buildable smart-model turn');
  return build;
}

type SlotNode = Extract<Node, { type: 'smartModel' }>;
type CallNode = Extract<Node, { type: 'modelCall' }>;

function slotOf(definition: WorkflowDefinition): SlotNode {
  const slot = definition.nodes.find((node): node is SlotNode => node.type === 'smartModel');
  if (slot === undefined) throw new Error('expected a Smart Model slot');
  return slot;
}

function siblingsOf(definition: WorkflowDefinition): readonly CallNode[] {
  return definition.nodes.filter(
    (node): node is CallNode =>
      node.type === 'modelCall' && !isTurnClassifierNode(node, definition.nodes)
  );
}

function siblingOf(definition: WorkflowDefinition): CallNode {
  const [sibling] = siblingsOf(definition);
  if (sibling === undefined) throw new Error('expected a pinned sibling');
  return sibling;
}

describe('the decision domain of a Smart Model slot turn', () => {
  it('lists the slot’s own candidates, in its order, each with the presented rungs it answers at', async () => {
    const build = await compiledTurn();
    const slot = slotOf(build.definition);

    expect(build.classifier?.decisionDomain).toEqual({
      presentedEfforts: ['off', 'lite'],
      candidates: slot.candidates.map((candidate) => ({
        id: candidate.id,
        answerableRungs: MIN_ONLY.has(candidate.id) ? ['off'] : ['off', 'lite'],
      })),
    });
  });
});

/** One provider call as the provider saw it. */
interface Call {
  readonly request: InferenceRequest;
  readonly options: InferOptions | undefined;
}

interface Ran {
  readonly calls: readonly Call[];
  readonly decision: { readonly modelId?: string; readonly effort: ResolvedReasoningEffort };
}

function telemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

function bindingFor(id: string): ModelBinding | undefined {
  const descriptor = resolve(id);
  if (descriptor === undefined) return undefined;
  return { descriptor, ports: { in: [textTag()], out: textTag() }, price: () => ok(1n) };
}

const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

/** A chat turn declares no transform node, so the compute port resolves none and runs none. */
const NO_TRANSFORMS: TransformCompute = {
  execute: () => {
    throw new Error('a chat turn runs no transform');
  },
  resolvePorts: () => undefined,
};

/** Runs the compiled turn through the executors, the classifier answering `answer`. */
async function runTurn(build: MultiModelTurnBuild, answer: string): Promise<Ran> {
  const calls: Call[] = [];
  const decisions: Ran['decision'][] = [];
  const provider: ModelProvider = {
    infer: (request, _descriptor, options) => {
      calls.push({ request, options });
      return (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        yield {
          kind: 'text-delta',
          index: 0,
          content: request.routingOnly === true ? answer : 'the answer',
        };
        yield {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'stop',
            providerCostUsd: 0.000_001,
            generationId: `gen-${String(calls.length)}`,
          },
        };
      })();
    },
  };
  const reducers = new Map(
    [...reducerCode(DEFAULT_WORKFLOW_CAPABILITIES)].map(([name, run]) => [
      name,
      name === TURN_DECISION_REDUCER
        ? (inputs: readonly unknown[]): unknown => {
            const decided = run(inputs) as Ran['decision'];
            decisions.push(decided);
            return decided;
          }
        : run,
    ])
  );
  const registries = createTurnCompileRegistries(resolve);
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
  const execution = createLiveExecutionRegistry({
    provider,
    models: { resolve: bindingFor },
    compute: NO_TRANSFORMS,
    subWorkflows: { resolve: (ref) => NO_SUB_WORKFLOWS[ref] },
    schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers,
    tools: createToolRegistry({ search: { search: () => Promise.resolve({ results: [] }) } }),
  });
  const executor = createWorkflowExecutor({
    registries: { nodes: registries.nodes, constraints },
    execution,
    estimateRun: () => ok({ totalNanoUsd: nanoUSD(1_000_000n), calls: [] }),
    clock: { now: () => NOW_MS },
    rng: { random: () => 0.5 },
    telemetry: telemetry(),
  });
  const handle = executor.start({
    definition: build.definition,
    inputs: turnInputs(build, 'what changed in the news today?', []),
    hooks: {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'hold',
          circuit: {
            estimateNanoUsd: 10n ** 13n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 10n ** 13n,
          },
        }),
      settlement: () => Promise.resolve(),
    },
    runKey: 'decided-rung-run',
    emit: () => {},
  });
  const outcome = await handle.done;
  expect(outcome).toEqual({ outcome: 'succeeded' });
  const [decision] = decisions;
  if (decision === undefined) throw new Error('the turn made no decision');
  return { calls, decision };
}

function answerCallOf(ran: Ran, model: (id: string) => boolean): Call {
  const call = ran.calls.find(
    (candidate) => candidate.request.routingOnly !== true && model(candidate.request.model)
  );
  if (call === undefined) throw new Error('expected an answer call');
  return call;
}

/**
 * The compiled turn as it actually ran: each sibling at the parameters and steps
 * its call carried, and the slot, if any, holding only the candidate it bound,
 * at the cap its call carried. The run estimator prices this exactly as it
 * priced the hold.
 */
function asRan(definition: WorkflowDefinition, ran: Ran): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node): Node => {
      if (node.type === 'modelCall' && !isTurnClassifierNode(node, definition.nodes)) {
        const call = answerCallOf(ran, (id) => id === node.model);
        return {
          ...node,
          rungCeilings: undefined,
          params: call.request.parameters,
          maxSteps: call.options?.tools?.maxSteps ?? node.maxSteps,
        };
      }
      if (node.type === 'smartModel') {
        const call = answerCallOf(ran, (id) => node.candidates.some((c) => c.id === id));
        const { maxOutputTokens, ...params } = call.request.parameters;
        return {
          ...node,
          params,
          candidates: [
            {
              id: call.request.model,
              ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
            },
          ],
        };
      }
      return node;
    }),
  };
}

const MODEL_LINES = [
  ...[ENGINE, MANDATORY, LADDERLESS, OPEN].map((row) => `model: ${row.id}`),
  'model: vendor/unlisted',
  '',
];
const EFFORT_LINES = [
  `effort: ${REASONING_EFFORT_LABELS.off}`,
  `effort: ${REASONING_EFFORT_LABELS.lite}`,
  `effort: ${REASONING_EFFORT_LABELS.max}`,
  '',
];
const ANSWERS = MODEL_LINES.flatMap((model) =>
  EFFORT_LINES.map((effort) => [model, effort].filter((line) => line !== '').join('\n'))
);

describe('every classifier answer on the $0.71 searching slot turn', () => {
  it.each(ANSWERS)('runs one rung within the hold for the answer %j', async (answer) => {
    const build = await compiledTurn();
    const estimate = createEstimateTotal(resolve);
    const hold = estimate(build.definition)._unsafeUnwrap();
    const ran = await runTurn(build, answer);

    expect(estimate(asRan(build.definition, ran))._unsafeUnwrap()).toBeLessThanOrEqual(hold);
    const { effort, modelId } = ran.decision;
    const sibling = siblingOf(build.definition);
    const bound = slotOf(build.definition).candidates.find((candidate) => candidate.id === modelId);
    const siblingCall = answerCallOf(ran, (id) => id === sibling.model);
    const slotCall = answerCallOf(ran, (id) => id === modelId);
    expect(bound?.rungCeilings?.[effort]).toBeDefined();
    expect(siblingCall.request.parameters['maxOutputTokens']).toBe(sibling.rungCeilings?.[effort]);
    expect(siblingCall.options?.tools?.maxSteps).toBe(toolLoopStepsFor(toolCallCapFor(effort)));
    expect(slotCall.request.parameters['maxOutputTokens']).toBe(bound?.rungCeilings?.[effort]);
  });

  it('prices the mandatory candidate at Lite within the hold by running the turn at Min', async () => {
    const build = await compiledTurn();
    const estimate = createEstimateTotal(resolve);

    const ran = await runTurn(
      build,
      `model: ${MANDATORY.id}\neffort: ${REASONING_EFFORT_LABELS.lite}`
    );

    expect(estimate(asRan(build.definition, ran))._unsafeUnwrap()).toBeLessThanOrEqual(
      estimate(build.definition)._unsafeUnwrap()
    );
    expect(ran.decision).toMatchObject({ modelId: MANDATORY.id, effort: 'off' });
  });
});

interface GeneratedSend {
  readonly pinned: string;
  readonly funding: bigint;
  readonly promptChars: number;
  readonly tier: 'paid' | 'free';
  readonly slot: boolean;
}

/**
 * Generator `searchingAutoSends`: a searching Auto send pinning any model of the
 * catalog, beside the slot or beside one other pinned model, at a funding from
 * $0.05 to $20, most of it under $2 where the rungs open one at a time, and a
 * prompt of up to 40,000 characters. Pinning a cheaper model than the slot's
 * dearest candidate is what lets a lower rung's candidate set cost more than the
 * highest rung's, so the pinned sibling's entry there falls below its declared
 * cap.
 */
const searchingAutoSends: fc.Arbitrary<GeneratedSend> = fc.record({
  pinned: fc.constantFrom(...ROWS.map((row) => row.id)),
  funding: fc
    .oneof(
      { weight: 3, arbitrary: fc.bigInt({ min: 50n, max: 600n }) },
      { weight: 1, arbitrary: fc.bigInt({ min: 50n, max: 2000n }) },
      { weight: 1, arbitrary: fc.bigInt({ min: 50n, max: 20_000n }) }
    )
    .map((millicents) => millicents * 1_000_000n),
  promptChars: fc.oneof(fc.constant(40_000), fc.integer({ min: 1, max: 40_000 })),
  tier: fc.constantFrom<'paid' | 'free'>('paid', 'free'),
  slot: fc.boolean(),
});

/** A searching Auto send with no slot: `pinned` beside one other catalog model. */
function multiModelSend(budget: TurnBudget, pinned: string): MultiModelTurnBuild | undefined {
  const other = pinned === SONNET.id ? OPEN.id : SONNET.id;
  const outcome = compileMultiModelTurnOutcome(resolve, [pinned, other], {
    catalog: CATALOG,
    budget,
    webSearchEnabled: true,
    reasoningEffort: 'auto',
    nowMs: NOW_MS,
  })._unsafeUnwrap();
  return outcome.kind === 'built' ? outcome : undefined;
}

/** Each answer that binds a candidate answering at `rung`, or the effort line alone on a turn with no slot. */
function answersAt(definition: WorkflowDefinition, rung: ResolvedReasoningEffort): string[] {
  const effortLine = `effort: ${REASONING_EFFORT_LABELS[rung]}`;
  const slot = definition.nodes.find((node): node is SlotNode => node.type === 'smartModel');
  if (slot === undefined) return [effortLine];
  return slot.candidates
    .filter((candidate) => candidateAnsweringAt(candidate, rung) !== undefined)
    .map((candidate) => `model: ${candidate.id}\n${effortLine}`);
}

/** What running one built turn at every rung of its sibling's field found. */
interface RungRuns {
  readonly compared: number;
  readonly belowDeclared: number;
}

/**
 * Runs `build` at every rung its pinned sibling's field names, once per answer
 * binding a candidate there, and holds each priced run to the turn's hold.
 */
async function runEveryRung(
  build: MultiModelTurnBuild,
  field: Readonly<Partial<Record<ResolvedReasoningEffort, number>>>
): Promise<RungRuns> {
  const estimate = createEstimateTotal(resolve);
  const hold = estimate(build.definition)._unsafeUnwrap();
  const declared = Number(siblingOf(build.definition).params['maxOutputTokens']);
  const rungs = RungSchema.options.filter((one) => field[one] !== undefined);
  let compared = 0;
  for (const rung of rungs) {
    for (const answer of answersAt(build.definition, rung)) {
      const ran = await runTurn(build, answer);
      expect(ran.decision.effort).toBe(rung);
      expect(estimate(asRan(build.definition, ran))._unsafeUnwrap()).toBeLessThanOrEqual(hold);
      compared += 1;
    }
  }
  return {
    compared,
    belowDeclared: rungs.filter((rung) => (field[rung] ?? declared) < declared).length,
  };
}

describe('a node carrying per-rung ceilings, run at each rung its field allows', () => {
  it('is billed at most the hold the estimator priced, at every such rung', async () => {
    let compared = 0;
    let slotCompared = 0;
    let belowDeclared = 0;
    await fc.assert(
      fc.asyncProperty(searchingAutoSends, async ({ pinned, funding, promptChars, tier, slot }) => {
        const budget = budgetOf(funding, promptChars, tier);
        const build = slot ? await slotSend(budget, pinned) : multiModelSend(budget, pinned);
        const field = build === undefined ? undefined : siblingOf(build.definition).rungCeilings;
        if (build === undefined || field === undefined) return;
        const runs = await runEveryRung(build, field);
        compared += runs.compared;
        if (slot) slotCompared += runs.compared;
        belowDeclared += runs.belowDeclared;
      }),
      { numRuns: 1000 }
    );
    expect(compared).toBeGreaterThan(100);
    expect(slotCompared).toBeGreaterThan(50);
    // Rungs whose entry is below the sibling's declared cap: the case in which
    // running the declared cap instead of the entry would bill past the hold. They
    // sit in narrow funding bands on the paid tier, so the draws that reach them
    // are few.
    expect(belowDeclared).toBeGreaterThan(2);
  });
});

interface GapCase {
  readonly pinned: string;
  readonly funding: bigint;
  readonly answer: string;
}

/**
 * Sends where a lower rung's candidate set costs more than the highest rung's, so
 * the pinned sibling's entry at the decided rung is below the cap it declares.
 * Running that declared cap beside the lower rung's candidate would bill past
 * the hold.
 */
const GAP_CASES: readonly GapCase[] = [
  {
    pinned: LADDERLESS.id,
    funding: 110_000_000n,
    answer: `model: ${SONNET.id}\neffort: ${REASONING_EFFORT_LABELS.off}`,
  },
  {
    pinned: ENGINE.id,
    funding: 210_000_000n,
    answer: `model: ${SONNET.id}\neffort: ${REASONING_EFFORT_LABELS.low}`,
  },
  {
    pinned: MANDATORY.id,
    funding: 500_000_000n,
    answer: `model: ${SONNET.id}\neffort: ${REASONING_EFFORT_LABELS.lite}`,
  },
];

describe('a pinned sibling whose decided rung buys less than it declares', () => {
  it.each(GAP_CASES)(
    'runs $pinned at its entry for the decided rung, within the hold, at $funding nano-USD',
    async ({ pinned, funding, answer }) => {
      const build = await slotSend(budgetOf(funding, 40_000, 'paid'), pinned);
      if (build === undefined) throw new Error('expected a buildable smart-model turn');
      const estimate = createEstimateTotal(resolve);
      const ran = await runTurn(build, answer);
      const sibling = siblingOf(build.definition);
      const entry = sibling.rungCeilings?.[ran.decision.effort];

      expect(estimate(asRan(build.definition, ran))._unsafeUnwrap()).toBeLessThanOrEqual(
        estimate(build.definition)._unsafeUnwrap()
      );
      expect(entry).toBeLessThan(Number(sibling.params['maxOutputTokens']));
      expect(
        answerCallOf(ran, (id) => id === sibling.model).request.parameters['maxOutputTokens']
      ).toBe(entry);
    }
  );
});
