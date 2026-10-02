import { describe, expect, it, vi } from 'vitest';
import { nanoUSD, textTag } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
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
import { createTurnCompileRegistries, turnInputs } from '../turn/definition.js';
import { compileSmartModelBuild } from './turn.js';
import { buildSmartModelCandidates, snapshotResolver } from '../../../models/index.js';
import type {
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  SettlementRequest,
} from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { ModelProvider, SmartModelCandidates } from '../../../models/index.js';
import type { TransformCompute } from '../../../media/index.js';
import type { ModelBinding, SubWorkflowBinding } from '../../../workflows/index.js';
import type { TurnBudget } from '../turn/definition.js';

/** The instant the menu is built at, and the fixture release stamp it is read
 * against: the producer classifies a row premium partly by recency, and a paid
 * payer is offered premium rows either way. */
const NOW_MS = TEST_DAY_START;
const FIXTURE_STAMP_SECONDS = secondsAt(NOW_MS);

/**
 * The production Smart Model build, executed. Every other pin in this directory
 * asserts the compiled SHAPE; this one runs the definition the route ships so
 * that "a classifier reserve is held" and "a classifier call happens" are the
 * same fact rather than two hopeful ones.
 */

const CHEAP = 'p/cheap';
const DEAR = 'p/dear';

function descriptorFor(id: string, output: bigint): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 100_000 },
    pricing: tokenPricingFixture({ input: 1000n, output: output }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const CATALOG = [descriptorFor(CHEAP, 1500n), descriptorFor(DEAR, 2000n)];
const resolve = snapshotResolver(CATALOG);
const SPENDABLE_NANO_USD = 2_000_000_000n;
const BUDGET: TurnBudget = {
  promptCharacterCount: 400,
  inputCharacterCount: 400,
  funding: { kind: 'purchased', spendableNanoUsd: nanoUSD(SPENDABLE_NANO_USD) },
};

/**
 * The menu the paid send's own producer draws from this catalog and wallet —
 * the only menu shape a route can hand the compile, per-candidate ceilings
 * included. Building one by hand here would run the definition against a shape
 * the product cannot ship.
 */
function paidMenu(): SmartModelCandidates {
  const picked = buildSmartModelCandidates({
    descriptors: CATALOG,
    balanceNanoUsd: SPENDABLE_NANO_USD,
    tier: 'paid',
    promptChars: BUDGET.promptCharacterCount,
    inputChars: BUDGET.inputCharacterCount,
    pinnedModelIds: [],
    webSearch: false,
    nowMs: NOW_MS,
  });
  if (picked === null) throw new Error('expected a buildable smart-model menu');
  return picked;
}

function makeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

function bindingFor(id: string): ModelBinding {
  return {
    descriptor: CATALOG.find((one) => one.id === id) ?? CATALOG[0]!,
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(5n),
  };
}

/** The smart turn resolves no sub-workflows; every ref misses. */
const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

interface RunResult {
  readonly outcome: { readonly outcome: string };
  readonly settlement: SettlementRequest | undefined;
  readonly requests: readonly InferenceRequest[];
}

/** Compiles the paid Smart Model turn and runs it, with the classifier answering `answer`. */
async function runSmartTurn(answer: string): Promise<RunResult> {
  const compiled = await compileSmartModelBuild(CATALOG, paidMenu(), { budget: BUDGET });
  const build = compiled._unsafeUnwrap();
  if (!build.buildable) throw new Error('expected a buildable smart-model turn');
  const requests: InferenceRequest[] = [];
  const provider: ModelProvider = {
    infer: (request: InferenceRequest) => {
      requests.push(request);
      const part = request.inputs[0];
      const text = part?.modality === 'text' ? part.text : '';
      const isClassifier = text.includes('[HUSHBOX_CLASSIFIER]');
      return (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        yield { kind: 'text-delta', index: 0, content: isClassifier ? answer : 'the answer' };
        yield {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'stop',
            providerCostUsd: 0.000_001,
            generationId: isClassifier ? 'gen-classifier' : 'gen-answer',
          },
        };
      })();
    },
  };
  const registries = createTurnCompileRegistries(resolve);
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
  const execution = createLiveExecutionRegistry({
    provider,
    models: { resolve: (id) => (id === CHEAP || id === DEAR ? bindingFor(id) : undefined) },
    compute: { execute: vi.fn(), resolvePorts: vi.fn() } as unknown as TransformCompute,
    subWorkflows: { resolve: (ref) => NO_SUB_WORKFLOWS[ref] },
    schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
  });
  const settlements: SettlementRequest[] = [];
  const executor = createWorkflowExecutor({
    registries: { nodes: registries.nodes, constraints },
    execution,
    estimateRun: () => ok({ totalNanoUsd: nanoUSD(1_000_000n), calls: [] }),
    clock: { now: () => 1000 },
    rng: { random: () => 0.5 },
    telemetry: makeTelemetry(),
  });
  const handle = executor.start({
    definition: build.definition,
    inputs: turnInputs(build, 'write me a sonnet', []),
    hooks: {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'hold',
          circuit: {
            estimateNanoUsd: 10_000_000_000n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 10_000_000_000n,
          },
        }),
      settlement: (request: SettlementRequest) => {
        settlements.push(request);
        return Promise.resolve();
      },
    },
    runKey: 'smart-run-key',
    emit: () => {},
  });
  const outcome = await handle.done;
  return { outcome, settlement: settlements[0], requests };
}

describe('the paid Smart Model turn, executed', () => {
  it('bills a classifier generation of its own', async () => {
    const run = await runSmartTurn(`model: ${DEAR}`);
    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    expect(run.settlement?.charges.map((charge) => charge.generationId)).toContain(
      'gen-classifier'
    );
  });

  it('binds the candidate the classifier named, not the cheapest', async () => {
    const routed = await runSmartTurn(`model: ${DEAR}`);
    const cheapest = await runSmartTurn(`model: ${CHEAP}`);
    const answerModelOf = (run: RunResult): string | undefined =>
      run.settlement?.charges.find((charge) => charge.generationId === 'gen-answer')?.modelId;
    expect(answerModelOf(routed)).toBe(DEAR);
    expect(answerModelOf(cheapest)).toBe(CHEAP);
  });

  it('feeds the classifier its own rendered prompt, never the answer prompt', async () => {
    const run = await runSmartTurn(`model: ${DEAR}`);
    const texts = run.requests.map((request) =>
      request.inputs[0]?.modality === 'text' ? request.inputs[0].text : ''
    );
    const classifierText = texts.find((text) => text.includes('[HUSHBOX_CLASSIFIER]'));
    expect(classifierText).toContain(DEAR);
    expect(texts).toContain('write me a sonnet');
    expect(classifierText).not.toBe('write me a sonnet');
  });
});
