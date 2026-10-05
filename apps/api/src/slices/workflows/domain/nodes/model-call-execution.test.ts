import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  Node as NodeSchema,
  buildTurnSystemPrompt,
  mediaTag,
  optionalTag,
  parseAssistantMessage,
  promptUtf8Bytes,
  serializeSegments,
  textTag,
  webSearchRowsInOrder,
} from '@hushbox/shared';
import {
  pickClassifiedEffortPlan,
  reasoningPlanModelFrom,
  toolCallCapFor,
  toolCallChargeNanoUsd,
  toolCallsOfSteps,
  toolLoopBound,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import { costAt, textCallCurve } from '@hushbox/shared/affordability/price/curve';
import {
  callInputUpperBoundTokens,
  costPartsAt,
} from '@hushbox/shared/affordability/price/reservation';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import {
  TEST_DAY_END,
  TEST_DAY_START,
  isoAt,
  secondsAt,
  testUuidV7,
} from '@hushbox/shared/test-time';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import { providerUsdToBillableNanoUsd } from '../../../billing/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { scrubSentryEvent } from '../../../../lib/telemetry/adapters/sentry-scrub.js';
import { createValueStore } from '../engine/value-store.js';
import { classifyInferenceFailure } from '../../../models/adapters/inference-error.js';
import {
  InferenceError,
  priceMediaBillableNanoUsd,
  priceUsageBillableNanoUsd,
  reserveMediaBillableNanoUsd,
} from '../../../models/index.js';
import { SERVED_BY_UNREPORTED, createModelCallExecution } from './model-call-execution.js';
import { TURN_DECISION_SCHEMA_NAME, TurnDecision } from './turn-decision.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  Modality,
  ModelDescriptor,
  Node,
  WebSearchEntry,
  WebSearchRow,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider, ToolLoopOptions } from '../../../models/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  EngineClock,
  NodeRunContext,
  NodeRunSuccess,
  SpendGate,
} from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';
import type { CallQuantities } from '@hushbox/shared/affordability/price/curve';
import type { ReservedCall } from '@hushbox/shared/affordability/price/reservation';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function descriptor(outputs: readonly Modality[] = ['text']): ModelDescriptor {
  return {
    id: 'answer-model',
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

/** A video descriptor declaring a discrete supported-duration set (the per-model
 * `durationSeconds` enum ParamSpec the duration pre-flight enforces). */
function videoDescriptorWithDurations(values: readonly number[]): ModelDescriptor {
  return {
    ...descriptor(['video']),
    parameters: { durationSeconds: { type: 'enum', values: [...values], wire: 'providerOptions' } },
  };
}

/** The cap a fake binding prices every language call at. */
const FAKE_MAX_PRICE = { prompt: '7.500000', completion: '28.125217' };

/** The reserve price a fake binding holds a media call at: a cent, ten times past every returned cost here. */
const FAKE_RESERVE_NANO_USD = 10_000_000n;

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    descriptor: descriptor(),
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(50n),
    reserveMedia: () => ok(FAKE_RESERVE_NANO_USD),
    maxPrice: () => FAKE_MAX_PRICE,
    ...overrides,
  };
}

function modelCallNode(): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/** A modelCall node carrying the given request parameters (the media/token
 * extractor reads these off the resolved InferenceRequest). */
function modelCallNodeWithParams(
  params: Record<string, unknown>
): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params,
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/**
 * Terminal finish, optionally carrying the authoritative inline provider cost
 * and the terminal gateway generation id.
 */
function finish(providerCostUsd?: number, generationId?: string): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: 'stop',
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      ...(generationId === undefined ? {} : { generationId }),
    },
  };
}

/**
 * The billing facts a text `answer-model` generation carries up for settlement,
 * including the token dimension the finish's usage reports (3 in, 5 out; no
 * reasoning/cached).
 */
const TEXT_BILLING = {
  modelId: 'answer-model',
  providerName: SERVED_BY_UNREPORTED,
  modality: 'text',
  tokens: { inputTokens: 3, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
} as const;

/**
 * The billing facts when no terminal usage was observed (a finish-less stream or
 * an aborted partial): no token dimension is invented, so the charge carries no
 * `tokens`.
 */
const TEXT_BILLING_NO_TOKENS = {
  modelId: 'answer-model',
  providerName: SERVED_BY_UNREPORTED,
  modality: 'text',
} as const;

function stepFinish(step: number, providerCostUsd?: number): InferenceEvent {
  return {
    kind: 'step-finish',
    step,
    generationId: `gen-${String(step)}`,
    ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
  };
}

function streamOf(events: readonly InferenceEvent[]): ModelProvider {
  return {
    infer: () =>
      (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        for (const event of events) yield event;
      })(),
  };
}

/** Streams the given events while capturing each InferenceRequest it receives. */
function capturingProvider(
  events: readonly InferenceEvent[],
  requests: InferenceRequest[]
): ModelProvider {
  const inner = streamOf(events);
  return {
    infer: (request, requestDescriptor, options) => {
      requests.push(request);
      return inner.infer(request, requestDescriptor, options);
    },
  };
}

/** Streams the given events, then throws — the shape of a mid-stream failure. */
function throwingAfterProvider(events: readonly InferenceEvent[], thrown: Error): ModelProvider {
  return {
    infer: () =>
      (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        for (const event of events) yield event;
        throw thrown;
      })(),
  };
}

/** A hard abort surfaces as the adapters' InferenceError code 'aborted'. */
function abortError(): InferenceError {
  return new InferenceError('aborted', 'Inference aborted: hard stop');
}

function throwingProvider(thrown: Error): ModelProvider {
  return {
    infer: (): AsyncIterable<InferenceEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<InferenceEvent>> => Promise.reject(thrown),
      }),
    }),
  };
}

function makeCtx(emit?: (event: InferenceEvent) => void): NodeRunContext {
  return {
    values: createValueStore(1_000_000),
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
    spend: { isOpen: () => true, report: () => undefined },
    runId: undefined,
    ...(emit === undefined ? {} : { emit }),
  };
}

describe('createModelCallExecution — a routing-only call', () => {
  it('marks the provider request routing-only so it carries no base preamble', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['[HUSHBOX_CLASSIFIER] pick one'], {
      ...makeCtx(),
      routingOnly: true,
    });
    expect(requests[0]?.routingOnly).toBe(true);
  });

  it('leaves an ordinary answer call unmarked', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(requests[0]?.routingOnly).toBeUndefined();
  });
});

/** A reserved call for `quantities`, held at `wireCapTokens` per step, as the estimator builds one. */
function reservedCallFor(quantities: CallQuantities, wireCapTokens: number): ReservedCall {
  const pricing = tokenPricingFixture({ input: 1n, output: 1n });
  const curve = textCallCurve(pricing, 'reserve', quantities, wireCapTokens);
  const regime = curve.regimes.at(-1);
  if (regime === undefined) throw new Error('a curve has a regime from 0');
  const parts = costPartsAt(curve, wireCapTokens);
  return {
    nodeId: 'answer',
    modelId: 'answer-model',
    pricing,
    quantities,
    steps: quantities.loop?.steps ?? 1,
    wireCapTokens,
    stepTiers: regime.stepTiers,
    ...parts,
    heldNanoUsd: costAt(curve, wireCapTokens),
  };
}

describe('a node run context', () => {
  it("cannot be built without the run's spend gate", () => {
    expectCompileTimeProof(() => {
      const withoutSpend: Omit<NodeRunContext, 'spend'> = makeCtx();
      // @ts-expect-error every node runs under the run's spend gate
      const ungated: NodeRunContext = withoutSpend;
      return ungated;
    });
  });

  it('cannot be built without the id of the run it serves', () => {
    expectCompileTimeProof(() => {
      const withoutRunId: Omit<NodeRunContext, 'runId'> = makeCtx();
      // @ts-expect-error every node names the run it serves, or says the caller minted none
      const anonymous: NodeRunContext = withoutRunId;
      return anonymous;
    });
  });
});

describe('a model binding', () => {
  it('cannot be built without a reserve-side media pricer', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error a binding must say what its media calls were reserved at
      const unreserved: ModelBinding = {
        descriptor: descriptor(),
        ports: { in: [textTag()], out: textTag() },
        price: () => ok(50n),
        maxPrice: () => FAKE_MAX_PRICE,
      };
      return unreserved;
    });
  });

  it('cannot be built without a max_price pricer', () => {
    expectCompileTimeProof(() => {
      // @ts-expect-error a binding must cap its language calls
      const uncapped: ModelBinding = {
        descriptor: descriptor(),
        ports: { in: [textTag()], out: textTag() },
        price: () => ok(50n),
        reserveMedia: () => ok(50n),
      };
      return uncapped;
    });
  });
});

describe('createModelCallExecution — the price reservation', () => {
  const plainCall = reservedCallFor({ promptTokens: 2, persists: false, newMessageChars: 0 }, 64);

  /** The UTF-8 bytes of what a language request sends: its system prompt, history and input. */
  function promptBytesOf(
    request: InferenceRequest | undefined,
    history: readonly string[]
  ): number {
    if (request === undefined) throw new Error('no request was sent');
    return promptUtf8Bytes(
      [
        buildTurnSystemPrompt({
          utcDay: request.utcDay,
          ...(request.customInstructions === undefined
            ? {}
            : { customInstructions: request.customInstructions }),
        }),
        ...history,
        'hi',
      ].map((content) => ({ content }))
    );
  }

  it("routes a language call under its binding's max_price at the call's prompt bytes", async () => {
    const requests: InferenceRequest[] = [];
    const maxPrice = vi.fn(() => FAKE_MAX_PRICE);
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ maxPrice }),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), reservation: plainCall });

    expect(requests[0]?.routing).toEqual({ maxPrice: FAKE_MAX_PRICE });
    expect(maxPrice).toHaveBeenCalledExactlyOnceWith(promptBytesOf(requests[0], []));
  });

  it('counts the history and custom instructions the call sends into its bound', async () => {
    const requests: InferenceRequest[] = [];
    const maxPrice = vi.fn(() => FAKE_MAX_PRICE);
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ maxPrice }),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], {
      ...makeCtx(),
      reservation: plainCall,
      history: [{ role: 'user', content: '漢字 earlier' }],
      customInstructions: 'be brief',
    });

    expect(maxPrice).toHaveBeenCalledExactlyOnceWith(promptBytesOf(requests[0], ['漢字 earlier']));
  });

  it('leaves the base preamble out of a routing-only call’s bound, as that call sends none', async () => {
    const requests: InferenceRequest[] = [];
    const maxPrice = vi.fn(() => FAKE_MAX_PRICE);
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ maxPrice }),
      schemas,
    });
    const prompt = '[HUSHBOX_CLASSIFIER] pick one';

    await exec.run(modelCallNode(), [prompt], {
      ...makeCtx(),
      routingOnly: true,
      reservation: plainCall,
    });

    expect(maxPrice).toHaveBeenCalledExactlyOnceWith(promptUtf8Bytes([{ content: prompt }]));
  });

  it('adds the re-sent output, results and overhead its tool loop reserved', async () => {
    const requests: InferenceRequest[] = [];
    const maxPrice = vi.fn(() => FAKE_MAX_PRICE);
    const loop = toolLoopBound(['webSearch'], 2);
    const looped = reservedCallFor(
      { promptTokens: 2, loop, persists: false, newMessageChars: 0 },
      64
    );
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ maxPrice }),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), reservation: looped });

    const bytes = promptBytesOf(requests[0], []);
    expect(maxPrice).toHaveBeenCalledExactlyOnceWith(callInputUpperBoundTokens(looped, bytes));
    expect(callInputUpperBoundTokens(looped, bytes)).toBeGreaterThan(bytes);
  });

  it('sends a call the engine reserved nothing for without routing, which a provider refuses', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(requests[0]?.routing).toBeUndefined();
  });

  it('sends a media call no price cap, which media routing does not carry', async () => {
    const requests: InferenceRequest[] = [];
    const maxPrice = vi.fn(() => FAKE_MAX_PRICE);
    const exec = runExec({
      provider: capturingProvider([finish(0.01)], requests),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40n),
        maxPrice,
      }),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), reservation: plainCall });

    expect(requests[0]?.routing).toBeUndefined();
    expect(maxPrice).not.toHaveBeenCalled();
  });
});

describe('createModelCallExecution — the day the prompt renders', () => {
  it("takes the request's day from the run's engine clock", async () => {
    // Non-epoch, so a constant substituted for the clock read renders a different
    // day; and the last millisecond of a UTC day, the point at which a key derived
    // from anything but the UTC date is likeliest to differ.
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], {
      ...makeCtx(),
      clock: { now: () => TEST_DAY_END },
    });
    expect(requests[0]?.utcDay).toBe(isoAt(TEST_DAY_END).slice(0, 10));
  });
});

function fakeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

const schemas = { resolveSchema: vi.fn() };
const IMAGE: MediaValue = {
  ref: 'media/x/y/z',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: 4,
  metadata: {},
};
const VIDEO: MediaValue = {
  ref: 'media/v',
  mimeType: 'video/mp4',
  modality: 'video',
  byteLength: 4,
  metadata: {},
};

/** Wires the real (injected) port charge conversion so tests read like production. */
function runExec(
  deps: Omit<Parameters<typeof createModelCallExecution>[0], 'usdToBillableNanoUsd'>
): ReturnType<typeof createModelCallExecution> {
  return createModelCallExecution({ usdToBillableNanoUsd: providerUsdToBillableNanoUsd, ...deps });
}

/** A modelCall consuming the turn's decision envelope rather than raw text. */
function decidingNode(params: Record<string, unknown> = {}): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params,
    inputSchema: TURN_DECISION_SCHEMA_NAME,
    in: { node: 'decide', port: 'out' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/** A modelCall whose effort the user fixed: the level is stamped beside its wire. */
function pinnedEffortNode(
  reasoningEffort: string,
  params: Record<string, unknown>
): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params,
    reasoningEffort,
    inputSchema: TURN_DECISION_SCHEMA_NAME,
    in: { node: 'decide', port: 'out' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/** The registry a decision-consuming node validates its input through. */
const decisionSchemas = {
  resolveSchema: (name: string): z.ZodType | undefined =>
    name === TURN_DECISION_SCHEMA_NAME ? TurnDecision : undefined,
};

/** A budget-native reasoning model — it offers the whole canonical ladder. */
const REASONING_DESCRIPTOR: ModelDescriptor = {
  ...descriptor(),
  reasoning: { supportedEfforts: null },
  limits: { contextLength: 200_000 },
};

describe('createModelCallExecution — the decision envelope', () => {
  it("sends the envelope's prompt, never the envelope itself", async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'write me a poem', effort: 'high' };
    const result = await exec.run(decidingNode(), [decision], makeCtx());
    expect(result.isOk()).toBe(true);
    expect(requests[0]?.inputs).toEqual([{ modality: 'text', text: 'write me a poem' }]);
  });

  it('applies the classified effort to its own call within the cap admission priced', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'high' };
    await exec.run(decidingNode({ maxOutputTokens: 40_000 }), [decision], makeCtx());
    expect(requests[0]?.parameters['reasoning']).toBeDefined();
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(40_000);
  });

  it('leaves a pinned effort alone — the decision never overrides what the user fixed', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const pinned = { effort: 'low' };
    const decision = { prompt: 'p', effort: 'max' };
    await exec.run(
      decidingNode({ maxOutputTokens: 40_000, reasoning: pinned }),
      [decision],
      makeCtx()
    );
    expect(requests[0]?.parameters['reasoning']).toEqual(pinned);
  });

  it('sends no reasoning wire when the model has nothing to spend a budget on', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish()], requests),
      binding: binding(),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'high' };
    await exec.run(decidingNode({ maxOutputTokens: 40_000 }), [decision], makeCtx());
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: 40_000 });
  });

  it('records the level the call resolved to, not the level classified', async () => {
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    // The cap leaves no whole answer token above Max's budget, so the walk
    // steps down; the record must name the rung that ran.
    const decision = { prompt: 'p', effort: 'max' };
    const result = await exec.run(decidingNode({ maxOutputTokens: 40_000 }), [decision], makeCtx());
    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBe('high');
  });

  it('records the level the user pinned, on a call no decision could rewrite', async () => {
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'max' };
    const node = pinnedEffortNode('low', { maxOutputTokens: 40_000, reasoning: { effort: 'low' } });
    const result = await exec.run(node, [decision], makeCtx());
    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBe('low');
  });

  it('records no level on a reasoning-capable call nobody asked to reason', async () => {
    // The model could reason and the axis has a declared fallback, but this call
    // was neither pinned nor classified — so no wire was sent, and "reasoning
    // does not apply" must not be recorded as the fallback rung.
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ maxOutputTokens: 40_000 }),
      ['p'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBeUndefined();
  });

  it('stamps the resolved level onto the finish frame the client watches', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'max' };
    await exec.run(
      decidingNode({ maxOutputTokens: 40_000 }),
      [decision],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted.at(-1)).toHaveProperty('reasoningEffort', 'high');
  });

  it('streams and records ONE resolution, never two that merely agree', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'max' };
    const result = await exec.run(
      decidingNode({ maxOutputTokens: 40_000 }),
      [decision],
      makeCtx((event) => emitted.push(event))
    );
    const streamed = emitted.at(-1) as { reasoningEffort?: string };
    expect(streamed.reasoningEffort).toBe(result._unsafeUnwrap().billing?.reasoningEffort);
  });

  it('stamps a pinned off onto the finish frame as a recorded level', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
    });
    const decision = { prompt: 'p', effort: 'max' };
    const node = pinnedEffortNode('off', {
      maxOutputTokens: 40_000,
      reasoning: { enabled: false },
    });
    await exec.run(
      node,
      [decision],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted.at(-1)).toHaveProperty('reasoningEffort', 'off');
  });

  it('leaves the finish frame levelless when the call sent no reasoning wire', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas,
    });
    await exec.run(
      modelCallNodeWithParams({ maxOutputTokens: 40_000 }),
      ['p'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted.at(-1)).not.toHaveProperty('reasoningEffort');
  });

  it('fails closed on a malformed value where the envelope was declared', async () => {
    const exec = runExec({
      provider: streamOf([finish()]),
      binding: binding(),
      schemas: decisionSchemas,
    });
    const result = await exec.run(decidingNode(), [{ prompt: 'p', effort: 'turbo' }], makeCtx());
    expect(result.isErr()).toBe(true);
  });
});

describe('createModelCallExecution', () => {
  it('is a streaming execution', () => {
    const exec = runExec({ provider: streamOf([]), binding: binding(), schemas });
    expect(exec.streaming).toBe(true);
  });

  it('charges the authoritative inline provider cost for text with isEstimated false', async () => {
    const emitted: InferenceEvent[] = [];
    const events: InferenceEvent[] = [
      { kind: 'text-delta', index: 0, content: 'he' },
      { kind: 'text-delta', index: 1, content: 'llo' },
      finish(0.000_001),
    ];
    const exec = runExec({
      provider: streamOf(events),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    // 0.000001 USD → 1000 nano → 1150n billable; the fake estimate (50n) is not consulted.
    expect(result._unsafeUnwrap()).toEqual({
      value: 'hello',
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001),
      isEstimated: false,
      billing: TEXT_BILLING,
    });
    expect(emitted).toEqual([{ kind: 'stream-start', modelId: 'answer-model' }, ...events]);
  });

  it('emits stream-start with the request model as the FIRST event of a streaming call', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hello' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: 'answer-model' });
    // The label is stream metadata only: the accumulated value, cost, and
    // billing facts are identical to an unlabeled stream.
    expect(result._unsafeUnwrap()).toEqual({
      value: 'hello',
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001),
      isEstimated: false,
      billing: TEXT_BILLING,
    });
  });

  it('labels a media stream too — stream-start precedes media-start', async () => {
    const emitted: InferenceEvent[] = [];
    const events: InferenceEvent[] = [
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 0, value: IMAGE },
      finish(),
    ];
    const exec = runExec({
      provider: streamOf(events),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted).toEqual([
      { kind: 'stream-start', modelId: 'answer-model', outputModality: 'image' },
      ...events,
    ]);
  });

  it('labels a media stream-start with its output modality (the early tile signal)', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: IMAGE }, finish()]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({
      kind: 'stream-start',
      modelId: 'answer-model',
      outputModality: 'video',
    });
  });

  it('omits outputModality on a text stream-start (only media families carry it)', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hello' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: 'answer-model' });
  });

  it('never accumulates a provider-yielded stream-start into the resolved text', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'stream-start', modelId: 'answer-model' },
        { kind: 'text-delta', index: 0, content: 'clean' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('clean');
  });

  it('resolves the concatenated value without a client stream when emit is absent', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'quiet' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('quiet');
    expect(result._unsafeUnwrap().isEstimated).toBe(false);
  });

  it('charges the inline provider cost for a video generation with isEstimated false', async () => {
    const video: MediaValue = {
      ...IMAGE,
      ref: 'media/v',
      mimeType: 'video/mp4',
      modality: 'video',
    };
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
        { kind: 'media-done', index: 0, value: video },
        finish(0.000_002),
      ]),
      binding: binding({ descriptor: descriptor(['video']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: video,
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_002),
      isEstimated: false,
      billing: { modelId: 'answer-model', providerName: SERVED_BY_UNREPORTED, modality: 'video' },
    });
  });

  it('charges the inline provider cost for an image generation with isEstimated false', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(0.000_002),
      ]),
      binding: binding({
        descriptor: descriptor(['image']),
        // The token pricer must never be consulted for media: the finish's
        // token-only usage is unpriceable for an image model.
        price: () => err(validationError('image pricing is not token-priced')),
        priceMedia: () => ok(50n),
      }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: IMAGE,
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_002),
      isEstimated: false,
      // Image always records a count dimension (defaults to 1) for media_generations.
      billing: {
        modelId: 'answer-model',
        providerName: SERVED_BY_UNREPORTED,
        modality: 'image',
        media: { imageCount: 1 },
      },
    });
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  describe('media cost sanity threshold', () => {
    /** A media binding priced by the catalog's own pricers over `pricing`. */
    function mediaBinding(
      outputs: readonly Modality[],
      pricing: ModelDescriptor['pricing']
    ): ModelBinding {
      const family = outputs[0] === 'video' ? 'video' : 'image';
      return binding({
        descriptor: { ...descriptor(outputs), pricing },
        priceMedia: (params) => priceMediaBillableNanoUsd(pricing, family, params),
        reserveMedia: (params) => reserveMediaBillableNanoUsd(pricing, family, params),
      });
    }

    const VARIANT_IMAGE = perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n });
    const VIDEO_PARAMS = { resolution: '720p', durationSeconds: 4 };
    const KLING_VIDEO = perSecondPricingFixture({
      anchor: { '720p': 128_800_000n },
      dearest: { '720p': 193_200_000n },
    });

    async function runImage(
      pricing: ModelDescriptor['pricing'],
      costUsd: number,
      telemetry: Telemetry = fakeTelemetry()
    ): Promise<NodeRunSuccess> {
      const exec = runExec({
        provider: streamOf([
          { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
          { kind: 'media-done', index: 0, value: IMAGE },
          finish(costUsd),
        ]),
        binding: mediaBinding(['image'], pricing),
        schemas,
        telemetry,
      });
      const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
      return result._unsafeUnwrap();
    }

    async function runVideo(costUsd: number, telemetry: Telemetry): Promise<NodeRunSuccess> {
      const video: MediaValue = {
        ...IMAGE,
        ref: 'media/v',
        mimeType: 'video/mp4',
        modality: 'video',
      };
      const exec = runExec({
        provider: streamOf([
          { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
          { kind: 'media-done', index: 0, value: video },
          finish(costUsd),
        ]),
        binding: mediaBinding(['video'], KLING_VIDEO),
        schemas,
        telemetry,
      });
      const result = await exec.run(modelCallNodeWithParams(VIDEO_PARAMS), ['hi'], makeCtx());
      return result._unsafeUnwrap();
    }

    it("bills an image cost at exactly 10× the call's dearest-row price in full", async () => {
      // $0.90 is 1,035,000,000 billable nano: 10 × the 103,500,000 dearest row.
      const result = await runImage(VARIANT_IMAGE, 0.9);
      expect(result).toMatchObject({ costNanoUsd: 1_035_000_000n, isEstimated: false });
    });

    it('refuses an image cost just above 10× the dearest-row price, billing the anchor estimate', async () => {
      const result = await runImage(VARIANT_IMAGE, 0.900_000_1);
      expect(result).toMatchObject({ costNanoUsd: 51_750_000n, isEstimated: true });
    });

    it('captures exactly once when it refuses an image cost above the threshold', async () => {
      const telemetry = fakeTelemetry();
      await runImage(VARIANT_IMAGE, 0.900_000_1, telemetry);
      expect(telemetry.captureError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        'inference_provider_cost_unavailable'
      );
    });

    it("bills a video cost at exactly 10× the call's dearest-SKU price in full", async () => {
      // 4 s at the 193,200,000 dearest 720p rate reserves 772,800,000; $6.72 is
      // 7,728,000,000 billable nano, exactly 10× that.
      const result = await runVideo(6.72, fakeTelemetry());
      expect(result).toMatchObject({ costNanoUsd: 7_728_000_000n, isEstimated: false });
    });

    it('refuses a video cost just above 10× the dearest-SKU price, billing the anchor estimate', async () => {
      const result = await runVideo(6.720_000_1, fakeTelemetry());
      expect(result).toMatchObject({ costNanoUsd: 515_200_000n, isEstimated: true });
    });

    it('captures exactly once when it refuses a video cost above the threshold', async () => {
      const telemetry = fakeTelemetry();
      await runVideo(6.720_000_1, telemetry);
      expect(telemetry.captureError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        'inference_provider_cost_unavailable'
      );
    });

    it('bills the returned cost for a listing whose 2-nano anchor sits beside a $0.045 row', async () => {
      const attack = perImagePricingFixture({ anchor: 2n, dearest: 51_750_000n });
      const result = await runImage(attack, 0.045);
      expect(result).toMatchObject({ costNanoUsd: 51_750_000n, isEstimated: false });
    });

    it('bills a text cost at exactly 1000× its estimate in full', async () => {
      // $0.001 is 1,150,000 billable nano: 1000 × the 1,150 estimate.
      const exec = runExec({
        provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(0.001)]),
        binding: binding({ price: () => ok(1150n) }),
        schemas,
      });
      const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
      expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 1_150_000n, isEstimated: false });
    });

    it('refuses a text cost just above 1000× its estimate', async () => {
      const exec = runExec({
        provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(0.001_000_1)]),
        binding: binding({ price: () => ok(1150n) }),
        schemas,
      });
      const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
      expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 1150n, isEstimated: true });
    });
  });

  it('bills the anchor estimate, not the reserve, flagged isEstimated on a missing image cost', async () => {
    // The catalog's media pricer itself, over a variant-priced row: the anchor
    // (the base row) is what an estimated charge bills; the dearest is only reserved.
    const pricing = perImagePricingFixture({ anchor: 51_750_000n, dearest: 103_500_000n });
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({
        descriptor: { ...descriptor(['image']), pricing },
        priceMedia: (params) => priceMediaBillableNanoUsd(pricing, 'image', params),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 51_750_000n, isEstimated: true });
  });

  it('raises one missing-cost alert when an image finish carries no cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
      telemetry,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(telemetry.captureError).toHaveBeenCalledExactlyOnceWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
  });

  it('falls back to the estimate and alerts when a text finish carries no inline cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish()]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
    expect(telemetry.warn).toHaveBeenCalled();
  });

  it('alerts and falls back to the deterministic media estimate on a missing video cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish()]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().costNanoUsd).toBe(70n);
    expect(result._unsafeUnwrap().isEstimated).toBe(true);
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it.each([
    ['fails', () => err(validationError('no reserve-side price'))],
    ['is zero', () => ok(0n)],
  ] as const)(
    'refuses a media inline cost whose reserve-side price %s, billing the estimate',
    async (_label, reserveMedia) => {
      const telemetry = fakeTelemetry();
      const exec = runExec({
        provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish(0.000_001)]),
        binding: binding({
          descriptor: descriptor(['video']),
          priceMedia: () => ok(70n),
          reserveMedia,
        }),
        schemas,
        telemetry,
      });
      const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
      expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 70n, isEstimated: true });
      expect(telemetry.captureError).toHaveBeenCalledOnce();
    }
  );

  it('bounds a video inline cost against the reserve-side media price, not the token estimate', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // 1000 USD is far beyond 10× the 70n reserve-side price — clearly corrupt.
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish(1000)]),
      binding: binding({
        descriptor: descriptor(['video']),
        priceMedia: () => ok(70n),
        reserveMedia: () => ok(70n),
      }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 70n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('fails the node closed when a media-family binding carries no media pricer', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('threads the node params into the media pricer', async () => {
    const priceMedia = vi.fn(() => ok(50n));
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia }),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(priceMedia).toHaveBeenCalledWith({});
  });

  it('uses the terminal summed cost for an agentic multi-step run', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        stepFinish(1, 0.000_002),
        finish(0.000_003), // adapter already sums per-step costs onto the terminal finish
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    // The terminal generation id is the final step's (the finish carries none).
    expect(result._unsafeUnwrap()).toEqual({
      value: '',
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_003),
      isEstimated: false,
      billing: { ...TEXT_BILLING, generationId: 'gen-1' },
    });
  });

  it('falls back to the per-step sum when the terminal omits the cost and every step reported one', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'a' },
        stepFinish(0, 0.000_001),
        stepFinish(1, 0.000_002),
        finish(), // no terminal cost — fall back to the per-step sum
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'a',
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_003),
      isEstimated: false,
      billing: { ...TEXT_BILLING, generationId: 'gen-1' },
    });
  });

  it('falls back to the estimate and alerts when a step of a multi-step run reports no cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'a' },
        stepFinish(0, 0.000_001),
        stepFinish(1),
        stepFinish(2, 0.000_002),
        // The adapter sums only the steps that reported, so the terminal figure
        // is an undercount of what the run actually cost.
        finish(0.000_003),
      ]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'a',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: { ...TEXT_BILLING, generationId: 'gen-2' },
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('bills the estimate when no step of a multi-step run reports a cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'a' },
        stepFinish(0),
        stepFinish(1),
        finish(),
      ]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 50n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('treats a partial per-step sum as unusable when the terminal omits the cost too', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'a' },
        stepFinish(0, 0.000_001),
        stepFinish(1),
        finish(),
      ]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 50n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('bills the estimate and alerts when the stream carries no terminal finish at all', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // No finish → no observed usage → the estimate is 0n (a legal no-charge).
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 0n,
      isEstimated: true,
      billing: TEXT_BILLING_NO_TOKENS,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('rejects a negative provider cost to the estimate and alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(-5)]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('rejects an absurd provider cost to the estimate and alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // 1000 USD is far more than 1000× the 50n base estimate — clearly corrupt.
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(1000)]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('captures the terminal generationId from the finish metadata', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'x' },
        finish(0.000_001, 'gen-final'),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing).toEqual({ ...TEXT_BILLING, generationId: 'gen-final' });
  });

  it('prefers the finish generationId over the last step-finish id', async () => {
    const exec = runExec({
      provider: streamOf([stepFinish(0, 0.000_001), finish(0.000_001, 'gen-terminal')]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing?.generationId).toBe('gen-terminal');
  });

  it('re-validates the resolved input against the declared ports', async () => {
    const exec = runExec({
      provider: streamOf([finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), [42], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure on a thrown InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('rate_limited', 'slow down')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('carries no wire reason for a generic InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('rate_limited', 'slow down')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBeUndefined();
  });

  it('carries the CONTENT_POLICY wire reason for a content-policy InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('content_policy', 'refused')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBe(ERROR_CODES.CONTENT_POLICY);
  });

  it('carries the NO_REASONING_ENDPOINTS wire reason for a no-reasoning-endpoints InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('no_reasoning_endpoints', 'no endpoints')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBe(ERROR_CODES.NO_REASONING_ENDPOINTS);
  });

  it('carries the NO_ELIGIBLE_ENDPOINT wire reason for a no-providers-available InferenceError on a reasoning-free call', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('no_providers_available', 'no endpoints')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr()).toEqual({ reason: ERROR_CODES.NO_ELIGIBLE_ENDPOINT });
  });

  it('rethrows an unexpected error so the interpreter contains it as a defect', async () => {
    const exec = runExec({
      provider: throwingProvider(new Error('boom')),
      binding: binding(),
      schemas,
    });
    await expect(exec.run(modelCallNode(), ['hi'], makeCtx())).rejects.toThrow('boom');
  });

  it('builds a media input part when the model accepts media', async () => {
    const media: MediaValue = {
      ref: 'inputs/r/x',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 3,
      metadata: {},
    };
    const captured: InferenceRequest[] = [];
    const provider = {
      infer: (request: InferenceRequest) => {
        captured.push(request);
        return streamOf([
          { kind: 'text-delta', index: 0, content: 'seen' },
          finish(0.000_001),
        ]).infer(request, descriptor());
      },
    };
    const mediaBinding: ModelBinding = {
      descriptor: { ...descriptor(), inputs: ['image' as const] },
      ports: { in: [mediaTag('image', ['image/png'])], out: textTag() },
      price: () => ok(0n),
      reserveMedia: () => ok(0n),
      maxPrice: () => FAKE_MAX_PRICE,
    };
    const exec = runExec({ provider, binding: mediaBinding, schemas });
    const result = await exec.run(modelCallNode(), [media], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('seen');
    expect(captured[0]?.inputs[0]).toEqual({
      modality: 'image',
      ref: { ref: 'inputs/r/x', mimeType: 'image/png', byteLength: 3 },
    });
  });

  it('fails when the resolved input cannot map to an inference input part', async () => {
    const optionalBinding = {
      ...binding(),
      ports: { in: [optionalTag(textTag())], out: textTag() },
    };
    const exec = runExec({
      provider: streamOf([finish(0.000_001)]),
      binding: optionalBinding,
      schemas,
    });
    const result = await exec.run(modelCallNode(), [undefined], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure when pricing the observed usage fails on the estimate path', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish()]),
      binding: binding({ price: () => err(validationError('no rate')) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('rejects an out-of-set video duration at pre-flight with UNSUPPORTED_DURATION, before the provider call', async () => {
    const exec = runExec({
      provider: throwingProvider(
        new Error('provider must not be called for an out-of-set duration')
      ),
      binding: binding({
        descriptor: videoDescriptorWithDurations([4, 8]),
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrapErr()).toEqual({ reason: ERROR_CODES.UNSUPPORTED_DURATION });
  });

  it('accepts an in-set numeric video duration and runs the generation', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({
        descriptor: videoDescriptorWithDurations([4, 8]),
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 8, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().value).toEqual(VIDEO);
  });

  it('accepts any duration for a video model that declares no discrete duration set (escape hatch)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('accepts any duration for a video model whose durationSeconds enum declares no values (degenerate spec)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({
        descriptor: {
          ...descriptor(['video']),
          parameters: { durationSeconds: { type: 'enum', wire: 'providerOptions' } },
        },
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('does not gate a language call carrying generation params (the duration pre-flight is video-only)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hi' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ maxOutputTokens: 100 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('does not gate an image call carrying generation params (the duration pre-flight is video-only)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: IMAGE }, finish()]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ aspectRatio: '1:1' }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });
});

describe('createModelCallExecution — run-scoped history', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ];

  it('threads the context history onto the inference request', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), history: HISTORY });
    expect(requests[0]?.history).toEqual(HISTORY);
  });

  it('omits history from the request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(requests[0]).not.toHaveProperty('history');
  });

  it('omits history from the request when the context history is empty', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), history: [] });
    expect(requests[0]).not.toHaveProperty('history');
  });
});

describe('createModelCallExecution — run-scoped custom instructions', () => {
  it('threads the context custom instructions onto the inference request', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNodeWithParams({ maxOutputTokens: 100 }), ['hi'], {
      ...makeCtx(),
      customInstructions: 'answer in haiku',
    });
    // Reaches the dedicated request field the language adapter folds into the
    // system prompt, sourced from the run-scoped ctx (never the node params)...
    expect(requests[0]?.customInstructions).toBe('answer in haiku');
    // ...and the node params pass through as the provider call parameters,
    // never carrying the instructions.
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: 100 });
  });

  it('omits custom instructions from the request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNodeWithParams({ maxOutputTokens: 100 }), ['hi'], makeCtx());
    expect(requests[0]).not.toHaveProperty('customInstructions');
    // The parameters pass through unchanged — no behavior change when absent.
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: 100 });
  });
});

describe('createModelCallExecution — tool loop', () => {
  const toolLoop = {
    registry: {
      webSearch: {
        description: 'search',
        inputSchema: z.object({}),
        execute: () => Promise.resolve(),
      },
    },
    maxSteps: 10,
  };

  it("passes the injected tools to the provider at the node's declared steps", async () => {
    const seen: (ToolLoopOptions | undefined)[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.tools);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas, tools: toolLoop });
    await exec.run(searchingNode(toolLoop.maxSteps), ['hi'], makeCtx());
    expect(seen[0]).toEqual({ registry: toolLoop.registry, maxSteps: toolLoop.maxSteps });
    expect(seen[0]?.registry).toBe(toolLoop.registry);
  });

  it('omits tools from the infer options when no tool loop is injected', async () => {
    const seen: unknown[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.tools);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(seen[0]).toBeUndefined();
  });
});

/** A node definition parsed through the schema, narrowed to a modelCall by its type. */
function modelCallOf(definition: unknown): Extract<Node, { type: 'modelCall' }> {
  const node = NodeSchema.parse(definition);
  if (node.type !== 'modelCall') throw new Error('the fixture is not a modelCall node');
  return node;
}

/** A modelCall declaring the web-search loop at `maxSteps` steps. */
function searchingNode(maxSteps = 11): Extract<Node, { type: 'modelCall' }> {
  return modelCallOf({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
    tools: ['webSearch'],
    maxSteps,
  });
}

/** The loop the live registry resolves for {@link searchingNode}: its tools and its steps. */
function searchLoop(maxSteps = 11): ToolLoopOptions {
  return {
    registry: {
      webSearch: {
        description: 'search',
        inputSchema: z.object({ query: z.string() }),
        execute: () => Promise.resolve({ results: [] }),
      },
    },
    maxSteps,
  };
}

function searchCall(id: string, query = 'q'): InferenceEvent {
  return { kind: 'tool-call', id, name: 'webSearch', args: { query } };
}

function searchResult(
  id: string,
  urls: readonly string[] = ['https://a.example/']
): InferenceEvent {
  return {
    kind: 'tool-result',
    id,
    name: 'webSearch',
    result: { results: urls.map((url) => ({ title: `title of ${url}`, url, snippet: 's' })) },
  };
}

/** What a run rejects with, or `undefined` when it resolves, which no error assertion accepts. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return await run.then(
    () => undefined,
    (error: unknown) => error
  );
}

/** An error's own property names, sorted: its whole field set. */
function ownKeysOf(error: unknown): string[] {
  return Object.getOwnPropertyNames(error).toSorted((a, b) => a.localeCompare(b));
}

describe('createModelCallExecution — each successful tool call is charged on the node', () => {
  it('charges one per-call search rate for each successful web-search execution', async () => {
    const without = await runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(0, 0.000_002),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    }).run(searchingNode(), ['hi'], makeCtx());
    const withSearch = await runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        searchCall('c1'),
        searchResult('c1'),
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(1, 0.000_001),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    }).run(searchingNode(), ['hi'], makeCtx());
    expect(withSearch._unsafeUnwrap().costNanoUsd).toBe(
      without._unsafeUnwrap().costNanoUsd + toolCallChargeNanoUsd('webSearch', 1)
    );
    expect(withSearch._unsafeUnwrap().isEstimated).toBe(false);
  });

  it('charges the whole inline figure plus every search that returned, on one exact line', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        searchCall('c1'),
        searchCall('c2'),
        searchResult('c1'),
        searchResult('c2'),
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        searchCall('c3'),
        searchResult('c3'),
        stepFinish(1, 0.000_001),
        { kind: 'step-start', step: 2 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(2, 0.000_001),
        finish(0.000_003),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: expect.any(String),
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_003) + toolCallChargeNanoUsd('webSearch', 3),
      isEstimated: false,
      billing: { ...TEXT_BILLING, generationId: 'gen-2' },
    });
  });

  it('throws on a tool result naming no declared tool, rather than charging or ignoring it', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'tool-call', id: 'c1', name: 'codeRunner', args: {} },
        { kind: 'tool-result', id: 'c1', name: 'codeRunner', result: {} },
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const error = await rejectionOf(exec.run(searchingNode(), ['hi'], makeCtx()));
    expect(error).toMatchObject({ name: 'UndeclaredToolResult', toolName: 'codeRunner' });
    expect(ownKeysOf(error)).toEqual(['message', 'name', 'stack', 'toolName']);
  });

  it('throws when successful tool calls exceed the call budget of the steps it ran with', async () => {
    // Three steps allow two calls; a third result means the adapter's budget failed.
    const exec = runExec({
      provider: streamOf([
        searchCall('c1'),
        searchCall('c2'),
        searchCall('c3'),
        searchResult('c1'),
        searchResult('c2'),
        searchResult('c3'),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(3),
    });
    const error = await rejectionOf(exec.run(searchingNode(3), ['hi'], makeCtx()));
    expect(error).toMatchObject({ name: 'ToolCallBudgetExceeded', budget: 2, count: 3 });
    expect(ownKeysOf(error)).toEqual(['budget', 'count', 'message', 'name', 'stack']);
  });

  it('throws on a tool result that answers no earlier call', async () => {
    const exec = runExec({
      provider: streamOf([
        searchResult('c1'),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const error = await rejectionOf(exec.run(searchingNode(), ['hi'], makeCtx()));
    expect(error).toMatchObject({
      name: 'UnmatchedToolResult',
      toolName: 'webSearch',
      callState: 'unseen',
    });
    expect(ownKeysOf(error)).toEqual(['callState', 'message', 'name', 'stack', 'toolName']);
  });

  it('throws on a second tool result for one call', async () => {
    const exec = runExec({
      provider: streamOf([
        searchCall('c1'),
        searchResult('c1'),
        searchResult('c1'),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const error = await rejectionOf(exec.run(searchingNode(), ['hi'], makeCtx()));
    expect(error).toMatchObject({ name: 'UnmatchedToolResult', callState: 'answered' });
  });

  it('throws on a tool result for a call that already failed', async () => {
    const exec = runExec({
      provider: streamOf([
        searchCall('c1'),
        { kind: 'tool-error', id: 'c1', name: 'webSearch', reason: 'failed' },
        searchResult('c1'),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const error = await rejectionOf(exec.run(searchingNode(), ['hi'], makeCtx()));
    expect(error).toMatchObject({ name: 'UnmatchedToolResult', callState: 'answered' });
  });

  it('keeps every search on the line when a lost step figure drops the model cost to the estimate', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        searchCall('c1'),
        searchCall('c2'),
        searchResult('c1'),
        searchResult('c2'),
        stepFinish(0),
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(1, 0.000_001),
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      telemetry,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: 50n + toolCallChargeNanoUsd('webSearch', 2),
      isEstimated: true,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('keeps a cheap answer on its inline figure beside the full budget of searches', async () => {
    // Ten searches cost far more than 1000x the 50n token estimate, so a search
    // charge compared against the estimate would push the model cost onto it.
    const telemetry = fakeTelemetry();
    const calls = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];
    const exec = runExec({
      provider: streamOf([
        ...calls.map((id) => searchCall(id)),
        ...calls.map((id) => searchResult(id)),
        { kind: 'text-delta', index: 0, content: 'ok' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      telemetry,
      tools: searchLoop(11),
    });
    const result = await exec.run(searchingNode(11), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001) + toolCallChargeNanoUsd('webSearch', 10),
      isEstimated: false,
    });
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('createModelCallExecution — a hard-stopped searching run settles its partial', () => {
  it('bills the partial inline cost plus the searches that returned before the hard stop', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'a' },
          searchCall('c1'),
          searchResult('c1'),
          stepFinish(0, 0.000_001),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001) + toolCallChargeNanoUsd('webSearch', 1),
      isEstimated: false,
    });
  });

  it('bills zero plus the returned searches when the hard-stopped partial observed no model cost', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'a' },
          searchCall('c1'),
          searchCall('c2'),
          searchResult('c1'),
          searchResult('c2'),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: toolCallChargeNanoUsd('webSearch', 2),
      isEstimated: true,
    });
  });

  it('bills the media estimate plus the returned searches for a hard-stopped media partial', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [searchCall('c1'), searchResult('c1'), { kind: 'media-done', index: 0, value: IMAGE }],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40_000_000n),
      }),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      value: IMAGE,
      costNanoUsd: 40_000_000n + toolCallChargeNanoUsd('webSearch', 1),
      isEstimated: true,
    });
  });

  it('fails a hard stop that streamed nothing, reporting its search spend as observed and charging nothing', async () => {
    const exec = runExec({
      provider: throwingAfterProvider([searchCall('c1'), searchResult('c1')], abortError()),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr()).toEqual({
      costNanoUsd: toolCallChargeNanoUsd('webSearch', 1),
    });
  });
});

/** A done search entry whose sources are {@link searchResult}'s for `urls`. */
function doneEntry(query: string, urls: readonly string[]): WebSearchEntry {
  return {
    query,
    status: 'done',
    sources: urls.map((url) => ({ title: `title of ${url}`, url })),
  };
}

const NO_NOT_RUN: WebSearchRow['notRun'] = { limit: 0, invalidQuery: 0 };

describe('createModelCallExecution — the stored text is the assistant-text tree', () => {
  it('stores a search made while reasoning inside the reasoning segment', async () => {
    const urls = ['https://a.example/', 'https://b.example/'];
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'reasoning-delta', index: 0, content: 'think' },
        searchCall('c1', 'q'),
        searchResult('c1', urls),
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        { kind: 'reasoning-delta', index: 0, content: 'more' },
        { kind: 'text-delta', index: 0, content: 'Answer' },
        stepFinish(1, 0.000_001),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(parseAssistantMessage(result._unsafeUnwrap().value as string)).toEqual([
      {
        kind: 'reasoning',
        children: [
          { kind: 'text', text: 'think' },
          {
            kind: 'webSearch',
            row: { v: 1, searches: [doneEntry('q', urls)], notRun: NO_NOT_RUN },
          },
          { kind: 'text', text: 'more' },
        ],
      },
      { kind: 'text', text: 'Answer' },
    ]);
  });

  it('stores a search made after the answer started inline in the answer', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: 'A' },
        searchCall('c1', 'q'),
        searchResult('c1'),
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'B' },
        stepFinish(1, 0.000_001),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(parseAssistantMessage(result._unsafeUnwrap().value as string)).toEqual([
      { kind: 'text', text: 'A' },
      {
        kind: 'webSearch',
        row: { v: 1, searches: [doneEntry('q', ['https://a.example/'])], notRun: NO_NOT_RUN },
      },
      { kind: 'text', text: 'B' },
    ]);
  });

  it('persists nothing for a hard stop after only searches, with no model text', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [searchCall('c1'), searchCall('c2'), searchResult('c1')],
        abortError()
      ),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('stores a search in flight at a hard stop as interrupted and does not bill it', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'A' },
          searchCall('c1', 'first'),
          searchCall('c2', 'second'),
          searchResult('c1'),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    const success = result._unsafeUnwrap();
    expect(parseAssistantMessage(success.value as string)).toEqual([
      { kind: 'text', text: 'A' },
      {
        kind: 'webSearch',
        row: {
          v: 1,
          searches: [
            doneEntry('first', ['https://a.example/']),
            { query: 'second', status: 'interrupted' },
          ],
          notRun: NO_NOT_RUN,
        },
      },
    ]);
    expect(success.costNanoUsd).toBe(toolCallChargeNanoUsd('webSearch', 1));
  });

  it('stores exactly as many done search entries as it bills searches', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        searchCall('c1'),
        searchCall('c2'),
        searchCall('c3'),
        searchResult('c1'),
        { kind: 'tool-error', id: 'c2', name: 'webSearch', reason: 'failed' },
        searchResult('c3'),
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(1, 0.000_001),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    const success = result._unsafeUnwrap();
    const done = webSearchRowsInOrder(parseAssistantMessage(success.value as string))
      .flatMap((row) => row.searches)
      .filter((entry) => entry.status === 'done').length;
    expect(done).toBe(2);
    expect(success.costNanoUsd).toBe(
      providerUsdToBillableNanoUsd(0.000_002) + toolCallChargeNanoUsd('webSearch', done)
    );
  });

  it('stores a call still unanswered when the stream finishes as interrupted and bills nothing for it', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: 'A' },
        searchCall('c1', 'q'),
        stepFinish(0, 0.000_001),
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    const success = result._unsafeUnwrap();
    expect(parseAssistantMessage(success.value as string)).toEqual([
      { kind: 'text', text: 'A' },
      {
        kind: 'webSearch',
        row: { v: 1, searches: [{ query: 'q', status: 'interrupted' }], notRun: NO_NOT_RUN },
      },
    ]);
    expect(success.costNanoUsd).toBe(providerUsdToBillableNanoUsd(0.000_001));
  });

  it("stores a plain answer as bare text, byte for byte the model's text", async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: ' pl' },
        { kind: 'text-delta', index: 1, content: 'ain\n' },
        stepFinish(0, 0.000_001),
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(' plain\n');
  });
});

describe('createModelCallExecution — a search row dropped to fit is reported', () => {
  const QUERY_MARKER = 'quokka-query-marker';
  const TITLE_MARKER = 'narwhal-title-marker';
  const URL_MARKER = 'axolotl-url-marker';
  const CALLS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];
  const SOURCES_PER_SEARCH = 5;

  /** Ten searches of five long sources each: far past the rows' storage allowance. */
  function oversizeStream(): InferenceEvent[] {
    const longResult = (id: string): InferenceEvent => ({
      kind: 'tool-result',
      id,
      name: 'webSearch',
      result: {
        results: Array.from({ length: SOURCES_PER_SEARCH }, (_unused, index) => ({
          title: `${TITLE_MARKER} ${'t'.repeat(180)}`,
          url: `https://example.com/${URL_MARKER}/${id}/${String(index)}/${'u'.repeat(400)}`,
          snippet: 's',
        })),
      },
    });
    return [
      ...CALLS.map((id) => searchCall(id, `${QUERY_MARKER} ${id}`)),
      ...CALLS.map((id) => longResult(id)),
      { kind: 'text-delta', index: 0, content: 'answer' },
      finish(0.000_001),
    ];
  }

  async function runOversize(telemetry: Telemetry): Promise<NodeRunSuccess> {
    const exec = runExec({
      provider: streamOf(oversizeStream()),
      binding: binding(),
      schemas,
      telemetry,
      tools: searchLoop(11),
    });
    const result = await exec.run(searchingNode(11), ['hi'], makeCtx());
    return result._unsafeUnwrap();
  }

  function capturedErrors(telemetry: Telemetry): Error[] {
    return vi.mocked(telemetry.captureError).mock.calls.map(([error]) => error);
  }

  it('captures exactly one search_row_oversize event when sources are dropped to fit', async () => {
    const telemetry = fakeTelemetry();
    await runOversize(telemetry);
    expect(vi.mocked(telemetry.captureError).mock.calls.map(([, code]) => code)).toEqual([
      'search_row_oversize',
    ]);
  });

  it('reports the dropped sources by their count alone', async () => {
    const telemetry = fakeTelemetry();
    const success = await runOversize(telemetry);
    const stored = webSearchRowsInOrder(parseAssistantMessage(success.value as string))
      .flatMap((row) => row.searches)
      .reduce((sum, entry) => sum + (entry.sources?.length ?? 0), 0);
    const dropped = CALLS.length * SOURCES_PER_SEARCH - stored;
    expect(dropped).toBeGreaterThan(0);
    const errors = capturedErrors(telemetry);
    expect(
      errors.map((error) =>
        Object.getOwnPropertyNames(error).toSorted((a, b) => a.localeCompare(b))
      )
    ).toEqual([['droppedSourceCount', 'message', 'name', 'stack']]);
    expect(errors.map((error) => Reflect.get(error, 'droppedSourceCount'))).toEqual([dropped]);
  });

  it('carries no query, title or url text in the capture', async () => {
    const telemetry = fakeTelemetry();
    await runOversize(telemetry);
    const [error] = capturedErrors(telemetry);
    const surfaces = [
      error?.message,
      error?.stack,
      error?.name,
      JSON.stringify(error),
      String(error?.cause),
    ].join('\n');
    for (const marker of [QUERY_MARKER, TITLE_MARKER, URL_MARKER]) {
      expect(surfaces).not.toContain(marker);
    }
  });

  it('reaches Sentry with its dropped count as the only tag beside its code', async () => {
    const telemetry = fakeTelemetry();
    await runOversize(telemetry);
    const [error] = capturedErrors(telemetry);
    const event: Parameters<typeof scrubSentryEvent>[0] = {
      type: undefined,
      tags: { errorCode: 'search_row_oversize' },
    };
    const scrubbed = scrubSentryEvent(event, { originalException: error });
    expect(scrubbed?.tags).toEqual({
      errorCode: 'search_row_oversize',
      droppedSourceCount: Reflect.get(error ?? {}, 'droppedSourceCount'),
    });
    for (const marker of [QUERY_MARKER, TITLE_MARKER, URL_MARKER]) {
      expect(JSON.stringify(scrubbed)).not.toContain(marker);
    }
  });
});

describe('createModelCallExecution — a failed searching run', () => {
  it('reports the search spend of an inference failure as observed cost and charges nothing', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [searchCall('c1'), searchCall('c2'), searchResult('c1'), searchResult('c2')],
        new InferenceError('content_policy', 'refused')
      ),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr()).toEqual({
      reason: ERROR_CODES.CONTENT_POLICY,
      costNanoUsd: toolCallChargeNanoUsd('webSearch', 2),
    });
  });

  it('reports the search spend of a run whose cost cannot be priced as observed cost and charges nothing', async () => {
    // No inline figure sends the model cost to the estimate, and the estimate fails.
    const exec = runExec({
      provider: streamOf([
        searchCall('c1'),
        searchCall('c2'),
        searchResult('c1'),
        searchResult('c2'),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(),
      ]),
      binding: binding({ price: () => err(validationError('no rate')) }),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr()).toEqual({
      costNanoUsd: toolCallChargeNanoUsd('webSearch', 2),
    });
  });

  it('reports no observed cost for an unpriceable run that made no search', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'answer' }, finish()]),
      binding: binding({ price: () => err(validationError('no rate')) }),
      schemas,
      tools: searchLoop(),
    });
    const result = await exec.run(searchingNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr()).toEqual({});
  });
});

/** A searching modelCall consuming the turn's decision, optionally with a pinned effort. */
function decidingSearchNode(
  params: Record<string, unknown>,
  reasoningEffort?: string
): Extract<Node, { type: 'modelCall' }> {
  return modelCallOf({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    inputSchema: TURN_DECISION_SCHEMA_NAME,
    in: { node: 'decide', port: 'out' },
    tools: ['webSearch'],
    maxSteps: 11,
  });
}

describe('createModelCallExecution — the tool loop runs at the decided rung', () => {
  it('runs a classified node that decides Low at most 5 calls under a declared 11 steps', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
      tools: searchLoop(11),
    });
    const decision = { prompt: 'p', effort: 'low' };
    await exec.run(decidingSearchNode({ maxOutputTokens: 40_000 }), [decision], makeCtx());
    const steps = sink.options?.tools?.maxSteps ?? 0;
    expect(toolCallsOfSteps(steps)).toBe(5);
  });

  it("leaves a pinned node's loop at its declared steps whatever the decision", async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
      tools: searchLoop(11),
    });
    const decision = { prompt: 'p', effort: 'off' };
    const node = decidingSearchNode(
      { maxOutputTokens: 40_000, reasoning: { effort: 'low' } },
      'low'
    );
    await exec.run(node, [decision], makeCtx());
    expect(sink.options?.tools?.maxSteps).toBe(11);
  });

  it('holds a classified Low node to the carved budget, so a sixth search result throws', async () => {
    const calls = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const exec = runExec({
      provider: streamOf([
        ...calls.map((id) => searchCall(id)),
        ...calls.map((id) => searchResult(id)),
        { kind: 'text-delta', index: 0, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding({ descriptor: REASONING_DESCRIPTOR }),
      schemas: decisionSchemas,
      tools: searchLoop(11),
    });
    const decision = { prompt: 'p', effort: 'low' };
    const error = await rejectionOf(
      exec.run(decidingSearchNode({ maxOutputTokens: 40_000 }), [decision], makeCtx())
    );
    expect(error).toMatchObject({ name: 'ToolCallBudgetExceeded', budget: 5, count: 6 });
  });
});

/** What one call carried: its request and its infer options. */
interface CallSink {
  request?: InferenceRequest;
  options?: InferOptions | undefined;
}

function callCapturingProvider(events: readonly InferenceEvent[], sink: CallSink): ModelProvider {
  return {
    infer: (request, requestDescriptor, options) => {
      sink.request = request;
      sink.options = options;
      return streamOf(events).infer(request, requestDescriptor, options);
    },
  };
}

/**
 * A searching node of an Auto turn, declared at Max's loop and ceiling, with the
 * ceiling each rung's own solve bought: the cheaper a rung's loop, the more its
 * answer may hold.
 */
function perRungSearchNode(
  params: Record<string, unknown> = {},
  reasoningEffort?: string
): Extract<Node, { type: 'modelCall' }> {
  return modelCallOf({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: { maxOutputTokens: 8000, ...params },
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    inputSchema: TURN_DECISION_SCHEMA_NAME,
    in: { node: 'decide', port: 'out' },
    tools: ['webSearch'],
    maxSteps: toolLoopStepsFor(toolCallCapFor('max')),
    rungCeilings: { off: 16_000, lite: 15_000, low: 14_000, high: 10_000, max: 8000 },
  });
}

async function runPerRung(
  node: Extract<Node, { type: 'modelCall' }>,
  effort: string
): Promise<CallSink> {
  const sink: CallSink = {};
  const exec = runExec({
    provider: callCapturingProvider([finish(0.000_001)], sink),
    binding: binding({ descriptor: REASONING_DESCRIPTOR }),
    schemas: decisionSchemas,
    tools: searchLoop(node.maxSteps),
  });
  await exec.run(node, [{ prompt: 'p', effort }], makeCtx());
  return sink;
}

describe('createModelCallExecution — a node carrying per-rung ceilings', () => {
  it("a classified node that decides Low runs at the Low rung's ceiling from the node's per-rung field", async () => {
    const sink = await runPerRung(perRungSearchNode(), 'low');

    expect(sink.request?.parameters['maxOutputTokens']).toBe(14_000);
  });

  it("a classified node that decides High runs at the High rung's ceiling", async () => {
    const sink = await runPerRung(perRungSearchNode(), 'high');

    expect(sink.request?.parameters['maxOutputTokens']).toBe(10_000);
  });

  it('carves the decided rung’s reasoning budget out of that rung’s ceiling', async () => {
    // High's budget fits its own ceiling but not the declared one, where the walk
    // would step the level down.
    const model = reasoningPlanModelFrom(REASONING_DESCRIPTOR);
    const node = { ...perRungSearchNode(), rungCeilings: { high: 60_000, max: 8000 } };

    const sink = await runPerRung(node, 'high');

    expect(pickClassifiedEffortPlan(model, 'high', 8000)?.level).not.toBe('high');
    expect(sink.request?.parameters['reasoning']).toEqual(
      pickClassifiedEffortPlan(model, 'high', 60_000)?.wire
    );
  });

  it('runs the decided rung’s tool loop beside that rung’s ceiling', async () => {
    const sink = await runPerRung(perRungSearchNode(), 'low');

    expect(sink.options?.tools?.maxSteps).toBe(toolLoopStepsFor(toolCallCapFor('low')));
  });

  it('runs a node without the field at its declared ceiling, as before', async () => {
    const sink = await runPerRung({ ...perRungSearchNode(), rungCeilings: undefined }, 'low');

    expect(sink.request?.parameters['maxOutputTokens']).toBe(8000);
  });

  it('runs a fixed-wire node carrying the field at the decided rung’s ceiling, its wire unchanged', async () => {
    const wire = { effort: 'low' };
    const node = perRungSearchNode({ reasoning: wire }, 'low');

    const sink = await runPerRung(node, 'off');

    expect(sink.request?.parameters).toEqual({ maxOutputTokens: 16_000, reasoning: wire });
  });

  it('runs a fixed-wire node carrying the field at the decided rung’s loop', async () => {
    const node = perRungSearchNode({ reasoning: { effort: 'low' } }, 'low');

    const sink = await runPerRung(node, 'off');

    expect(sink.options?.tools?.maxSteps).toBe(toolLoopStepsFor(toolCallCapFor('off')));
  });
});

describe('createModelCallExecution — file-part mapper forwarding', () => {
  it('forwards the injected mapFilePart to the provider on the infer call', async () => {
    const mapper: FilePartMapper = () => {
      throw new Error('opaque: the node must never invoke the mapper');
    };
    const seen: unknown[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.mapFilePart);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), mapFilePart: mapper });
    expect(seen[0]).toBe(mapper);
  });

  it('omits mapFilePart from the infer options when the context carries none', async () => {
    const seen: object[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        if (options !== undefined) seen.push(options);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect('mapFilePart' in (seen[0] ?? {})).toBe(false);
  });
});

describe('createModelCallExecution — a hard abort settles the streamed partial', () => {
  it('resolves the accumulated text on abort, zero-cost estimated when no cost was observed', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'par' },
          { kind: 'text-delta', index: 1, content: 'tial' },
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'partial',
      costNanoUsd: 0n,
      isEstimated: true,
      billing: TEXT_BILLING_NO_TOKENS,
    });
  });

  it('prefers accumulated media over text on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'caption' },
          { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
          { kind: 'media-done', index: 0, value: IMAGE },
        ],
        abortError()
      ),
      binding: binding({ descriptor: descriptor(['image']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toEqual(IMAGE);
  });

  it('fails the node on abort when nothing accumulated (an empty abort bills nothing)', async () => {
    const exec = runExec({
      provider: throwingAfterProvider([], abortError()),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('bills the completed-step inline cost exactly on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }, stepFinish(0, 0.000_001)],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'a',
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001),
      isEstimated: false,
      billing: { ...TEXT_BILLING_NO_TOKENS, generationId: 'gen-0' },
    });
  });

  it('bills the deterministic media estimate when a completed artifact aborts with no inline cost', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
          { kind: 'media-done', index: 0, value: IMAGE },
        ],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40_000_000n),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      value: IMAGE,
      costNanoUsd: 40_000_000n,
      isEstimated: true,
    });
  });

  it('prefers the inline step cost over the media estimate on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }, stepFinish(0, 0.000_001)],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40_000_000n),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: providerUsdToBillableNanoUsd(0.000_001),
      isEstimated: false,
    });
  });

  it('falls back to zero estimated when the media estimate itself fails on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => err(validationError('unpriced')),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('keeps zero estimated for a media abort when the binding carries no media pricer', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('treats an invalid (negative) accumulated cost as unobserved on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }, stepFinish(0, -1)],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('still fails the node on a non-abort InferenceError even with accumulated text', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }],
        new InferenceError('rate_limited', 'slow down')
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });
});

describe('createModelCallExecution — billing dimension extraction', () => {
  it('extracts image media facts (n → imageCount, size → resolution) from the request params', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ n: 2, size: '1024x1024' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().billing).toEqual({
      modelId: 'answer-model',
      providerName: SERVED_BY_UNREPORTED,
      modality: 'image',
      media: { imageCount: 2, resolution: '1024x1024' },
    });
  });

  it('extracts video media facts, converting durationSeconds → durationMs exactly (×1000)', async () => {
    const video: MediaValue = {
      ...IMAGE,
      ref: 'media/v',
      mimeType: 'video/mp4',
      modality: 'video',
    };
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
        { kind: 'media-done', index: 0, value: video },
        finish(0.000_002),
      ]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 8, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().billing).toEqual({
      modelId: 'answer-model',
      providerName: SERVED_BY_UNREPORTED,
      modality: 'video',
      media: { durationMs: 8000, resolution: '720p' },
    });
  });

  it('populates the language token facts from the terminal usage (reasoning/cached counts carried through)', async () => {
    const richFinish: InferenceEvent = {
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 7, outputTokens: 11, reasoningTokens: 4, cachedInputTokens: 2 },
        finishReason: 'stop',
        providerCostUsd: 0.000_001,
      },
    };
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, richFinish]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing?.tokens).toEqual({
      inputTokens: 7,
      outputTokens: 11,
      reasoningTokens: 4,
      cachedInputTokens: 2,
    });
  });
});

/** Streams the events while capturing the InferOptions each `infer` receives. */
function optionsCapturingProvider(
  events: readonly InferenceEvent[],
  sink: { options?: InferOptions | undefined }
): ModelProvider {
  return {
    infer: (request, requestDescriptor, options) => {
      sink.options = options;
      return streamOf(events).infer(request, requestDescriptor, options);
    },
  };
}

function ctxWithStore(store: ReturnType<typeof createValueStore>): NodeRunContext {
  return {
    values: store,
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
    spend: { isOpen: () => true, report: () => undefined },
    runId: undefined,
  };
}

describe('createModelCallExecution — download byte cap threading', () => {
  it('threads the full remaining ValueStore budget to the provider as the download byte cap', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(createValueStore(1000)));

    expect(sink.options?.downloadByteCap).toBe(1000);
  });

  it('lowers the download byte cap by the bytes the ValueStore has already consumed', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const store = createValueStore(1000);
    // A stored 100-char string meters at length×2 = 200 bytes.
    const seeded = store.store('x'.repeat(100));
    expect(seeded.isOk()).toBe(true);
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(store));

    expect(sink.options?.downloadByteCap).toBe(800);
  });

  it('caps the download at the slice the ValueStore reserved for this call', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const store = createValueStore(1000);
    store.setConcurrencyCeiling(2);
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(store));

    expect(sink.options?.downloadByteCap).toBe(500);
  });

  it('releases its slice when the call ends, so the next call sees the budget again', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const store = createValueStore(1000);
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(store));
    await exec.run(modelCallNode(), ['hi'], ctxWithStore(store));

    expect(sink.options?.downloadByteCap).toBe(1000);
  });
});

describe('createModelCallExecution — streamed reasoning persists in the resolved value', () => {
  it('stores streamed reasoning as a reasoning segment ahead of the answer', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'reasoning-delta', index: 0, content: 'step one, ' },
        { kind: 'reasoning-delta', index: 0, content: 'step two' },
        { kind: 'text-delta', index: 0, content: 'the ' },
        { kind: 'text-delta', index: 1, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'step one, step two' }] },
        { kind: 'text', text: 'the answer' },
      ])
    );
  });

  it('resolves the answer verbatim when no reasoning text streamed', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'plain' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('plain');
  });

  it('resolves the answer verbatim when reasoning arrives as token counts only (o-series)', async () => {
    // Hidden-reasoning models report reasoningTokens on the terminal usage but
    // stream no reasoning text: the persisted value is the answer alone.
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'the answer' },
        {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 7 },
            finishReason: 'stop',
            providerCostUsd: 0.000_001,
          },
        },
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('the answer');
    expect(result._unsafeUnwrap().billing?.tokens?.reasoningTokens).toBe(7);
  });

  it('settles a reasoning-only aborted partial as billable content', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'reasoning-delta', index: 0, content: 'thoughts so far' }],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'thoughts so far' }] },
      ])
    );
  });

  it('stores the reasoning of an aborted partial that streamed both reasoning and text', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'reasoning-delta', index: 0, content: 'thoughts' },
          { kind: 'text-delta', index: 0, content: 'par' },
          { kind: 'text-delta', index: 1, content: 'tial' },
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'thoughts' }] },
        { kind: 'text', text: 'partial' },
      ])
    );
  });

  it('prefers accumulated media over reasoning-bearing text on a media call', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'reasoning-delta', index: 0, content: 'thoughts' },
        { kind: 'text-delta', index: 0, content: 'caption' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toEqual(IMAGE);
  });
});

/** One provider event and the engine-clock reading while the executor handles it. */
interface TimedEvent {
  readonly atMs: number;
  readonly event: InferenceEvent;
}

/**
 * A scripted provider whose engine clock reads each event's `atMs` while that
 * event is handled; `abortAtMs` ends the stream with a hard abort at that instant.
 */
function timedStream(
  events: readonly TimedEvent[],
  abortAtMs?: number
): { readonly provider: ModelProvider; readonly clock: EngineClock } {
  let nowMs = 0;
  return {
    clock: { now: () => nowMs },
    provider: {
      infer: () =>
        (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          for (const timed of events) {
            nowMs = timed.atMs;
            yield timed.event;
          }
          if (abortAtMs !== undefined) {
            nowMs = abortAtMs;
            throw abortError();
          }
        })(),
    },
  };
}

function reasoningAt(atMs: number): TimedEvent {
  return { atMs, event: { kind: 'reasoning-delta', index: 0, content: 'thinking ' } };
}

function textAt(atMs: number): TimedEvent {
  return { atMs, event: { kind: 'text-delta', index: 0, content: 'answer ' } };
}

async function reasoningDurationOf(
  stream: { readonly provider: ModelProvider; readonly clock: EngineClock },
  node: Extract<Node, { type: 'modelCall' }> = modelCallNode(),
  tools?: ToolLoopOptions
): Promise<number | undefined> {
  const result = await runExec({
    provider: stream.provider,
    binding: binding(),
    schemas,
    ...(tools === undefined ? {} : { tools }),
  }).run(node, ['hi'], { ...makeCtx(), clock: stream.clock });
  return result._unsafeUnwrap().billing?.reasoningDurationMs;
}

describe('createModelCallExecution — the reasoning time on the engine clock', () => {
  it('measures from the first reasoning delta to the first event after reasoning', async () => {
    const stream = timedStream([
      reasoningAt(0),
      reasoningAt(1000),
      reasoningAt(2500),
      textAt(3200),
      { atMs: 3300, event: finish(0.000_001) },
    ]);
    expect(await reasoningDurationOf(stream)).toBe(3200);
  });

  it('sums two reasoning spans split by a tool step', async () => {
    const stream = timedStream([
      { atMs: 0, event: { kind: 'step-start', step: 0 } },
      reasoningAt(100),
      reasoningAt(400),
      { atMs: 700, event: searchCall('c1') },
      { atMs: 900, event: searchResult('c1') },
      { atMs: 950, event: stepFinish(0, 0.000_001) },
      { atMs: 1000, event: { kind: 'step-start', step: 1 } },
      reasoningAt(1200),
      textAt(1500),
      { atMs: 1600, event: stepFinish(1, 0.000_001) },
      { atMs: 1650, event: finish(0.000_002) },
    ]);
    expect(await reasoningDurationOf(stream, searchingNode(), searchLoop())).toBe(600 + 300);
  });

  it('records no duration for a call that streamed no reasoning', async () => {
    const stream = timedStream([textAt(500), { atMs: 900, event: finish(0.000_001) }]);
    expect(await reasoningDurationOf(stream)).toBeUndefined();
  });

  it('closes a span the stream ended inside at its last reasoning delta', async () => {
    const stream = timedStream([reasoningAt(200), reasoningAt(800)]);
    expect(await reasoningDurationOf(stream)).toBe(600);
  });

  it('settles a hard abort inside reasoning with the time up to its last reasoning delta', async () => {
    const stream = timedStream([reasoningAt(0), reasoningAt(1500)], 1800);
    expect(await reasoningDurationOf(stream)).toBe(1500);
  });

  it('records the time in whole milliseconds', async () => {
    const stream = timedStream([reasoningAt(0.4), textAt(1000.2), { atMs: 1001, event: finish() }]);
    expect(await reasoningDurationOf(stream)).toBe(1000);
  });
});

/** Anchor rates 3,450 / 17,250 nano per token, and 6,900 / 25,875 above 200,000 prompt tokens. */
const TIERED_PRICING = tokenPricingFixture({
  input: 3450n,
  output: 17_250n,
  tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
});

/** A binding that prices observed usage with the production estimator over {@link TIERED_PRICING}. */
function tieredBinding(): ModelBinding {
  return binding({
    descriptor: { ...descriptor(), pricing: TIERED_PRICING },
    price: (usage) => priceUsageBillableNanoUsd(TIERED_PRICING, usage),
  });
}

interface StepReport {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly servedBy?: string;
}

/** A step-finish with no inline cost, carrying the step's usage and serving endpoint when given. */
function reportedStep(step: number, report: StepReport): InferenceEvent {
  const { inputTokens, outputTokens, servedBy } = report;
  return {
    kind: 'step-finish',
    step,
    generationId: `gen-${String(step)}`,
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { usage: { inputTokens, outputTokens } }),
    ...(servedBy === undefined ? {} : { servedBy }),
  };
}

/** The steps' events, then a finish with no inline cost carrying their summed usage. */
function uncostedLoop(
  steps: readonly StepReport[],
  summed: { in: number; out: number }
): InferenceEvent[] {
  return [
    { kind: 'text-delta', index: 0, content: 'answer' },
    ...steps.map((report, step) => reportedStep(step, report)),
    {
      kind: 'finish',
      metadata: {
        usage: { inputTokens: summed.in, outputTokens: summed.out },
        finishReason: 'stop',
      },
    },
  ];
}

async function chargedFor(events: readonly InferenceEvent[]): Promise<NodeRunSuccess> {
  const exec = runExec({ provider: streamOf(events), binding: tieredBinding(), schemas });
  const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
  return result._unsafeUnwrap();
}

describe('createModelCallExecution — the estimated charge prices each step', () => {
  it('prices each step at the tier its own input reached', async () => {
    const charged = await chargedFor(
      uncostedLoop(
        [
          { inputTokens: 150_000, outputTokens: 500 },
          { inputTokens: 190_000, outputTokens: 500 },
          { inputTokens: 230_000, outputTokens: 500 },
        ],
        { in: 570_000, out: 1500 }
      )
    );
    // Steps 1 and 2 at base, step 3 alone at the tier above 200,000.
    expect(charged.costNanoUsd).toBe(2_790_187_500n);
    expect(charged.isEstimated).toBe(true);
  });

  it('prices two steps that each crossed the threshold both at the tier', async () => {
    const charged = await chargedFor(
      uncostedLoop(
        [
          { inputTokens: 210_000, outputTokens: 500 },
          { inputTokens: 215_000, outputTokens: 800 },
        ],
        { in: 425_000, out: 1300 }
      )
    );
    expect(charged.costNanoUsd).toBe(2_966_137_500n);
  });

  it('prices the summed usage at base rates when a step reported no usage', async () => {
    const charged = await chargedFor(
      uncostedLoop(
        [
          { inputTokens: 150_000, outputTokens: 500 },
          {},
          { inputTokens: 230_000, outputTokens: 500 },
        ],
        { in: 570_000, out: 1500 }
      )
    );
    // 570,000 × 3,450 + 1,500 × 17,250: base rates, though the sum is past the threshold.
    expect(charged.costNanoUsd).toBe(1_992_375_000n);
  });

  it('prices the summed usage at base rates when the call reported no steps', async () => {
    const charged = await chargedFor(uncostedLoop([], { in: 570_000, out: 1500 }));
    expect(charged.costNanoUsd).toBe(1_992_375_000n);
  });
});

describe('createModelCallExecution — what the call observed rides its billing', () => {
  it('carries each step’s usage and the tool fees inside its charge', async () => {
    const result = await runExec({
      provider: streamOf([
        searchCall('c1'),
        searchCall('c2'),
        searchResult('c1'),
        searchResult('c2'),
        reportedStep(0, { inputTokens: 120, outputTokens: 30 }),
        { kind: 'text-delta', index: 0, content: 'answer' },
        reportedStep(1, { inputTokens: 400, outputTokens: 60 }),
        finish(0.000_002),
      ]),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    }).run(searchingNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrap().billing?.observed).toEqual({
      stepUsages: [
        { inputTokens: 120, outputTokens: 30 },
        { inputTokens: 400, outputTokens: 60 },
      ],
      toolFeeNanoUsd: toolCallChargeNanoUsd('webSearch', 2),
    });
  });

  it('keeps only the token counts of each step’s usage', async () => {
    const charged = await chargedFor([
      { kind: 'text-delta', index: 0, content: 'answer' },
      {
        kind: 'step-finish',
        step: 0,
        generationId: 'gen-0',
        usage: { inputTokens: 5, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 2 },
      },
      finish(0.000_001),
    ]);

    expect(charged.billing?.observed?.stepUsages).toEqual([{ inputTokens: 5, outputTokens: 7 }]);
  });

  it('carries no observation when a step reported no usage', async () => {
    const charged = await chargedFor(
      uncostedLoop([{ inputTokens: 150, outputTokens: 5 }, {}], { in: 300, out: 10 })
    );

    expect(charged.billing).not.toHaveProperty('observed');
  });

  it('carries no observation when the call reported no step', async () => {
    const charged = await chargedFor(uncostedLoop([], { in: 300, out: 10 }));

    expect(charged.billing).not.toHaveProperty('observed');
  });
});

describe('createModelCallExecution — the usage record names the serving endpoint', () => {
  async function providerNameFor(events: readonly InferenceEvent[]): Promise<string | undefined> {
    const charged = await chargedFor(events);
    return charged.billing?.providerName;
  }

  it('names the endpoint that served a single-step call', async () => {
    const name = await providerNameFor(
      uncostedLoop([{ inputTokens: 1, outputTokens: 1, servedBy: 'Amazon Bedrock' }], {
        in: 1,
        out: 1,
      })
    );
    expect(name).toBe('Amazon Bedrock');
  });

  it('names every endpoint of a call that fell back, in step order', async () => {
    const name = await providerNameFor(
      uncostedLoop(
        [
          { inputTokens: 1, outputTokens: 1, servedBy: 'Google Vertex' },
          { inputTokens: 1, outputTokens: 1, servedBy: 'Amazon Bedrock' },
        ],
        { in: 2, out: 2 }
      )
    );
    expect(name).toBe('Google Vertex, Amazon Bedrock');
  });

  it('names an endpoint that served several steps once', async () => {
    const name = await providerNameFor(
      uncostedLoop(
        [
          { inputTokens: 1, outputTokens: 1, servedBy: 'Amazon Bedrock' },
          { inputTokens: 1, outputTokens: 1, servedBy: 'Amazon Bedrock' },
        ],
        { in: 2, out: 2 }
      )
    );
    expect(name).toBe('Amazon Bedrock');
  });

  it('names the endpoint a call reports only on its finish', async () => {
    const name = await providerNameFor([
      { kind: 'text-delta', index: 0, content: 'answer' },
      {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'stop',
          servedBy: 'mock',
        },
      },
    ]);
    expect(name).toBe('mock');
  });

  it('records the endpoint as unreported when no step named one, never the model author', async () => {
    const name = await providerNameFor(
      uncostedLoop([{ inputTokens: 1, outputTokens: 1 }], { in: 1, out: 1 })
    );
    expect(name).toBe('unreported');
  });
});

describe('createModelCallExecution — a provider failure is reported', () => {
  /** What a provider error would carry into its own words: our account and the prompt. */
  const PROVIDER_TEXT_MARKER = 'pangolin-provider-text-marker';

  /**
   * The execution as a fresh isolate has it. What an isolate has already
   * reported is latched in module state, so each case takes the module again.
   */
  async function freshExecution(
    telemetry: Telemetry,
    thrown: Error
  ): Promise<ReturnType<typeof createModelCallExecution>> {
    vi.resetModules();
    const fresh = await import('./model-call-execution.js');
    return fresh.createModelCallExecution({
      usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
      provider: throwingProvider(thrown),
      binding: binding(),
      schemas,
      telemetry,
    });
  }

  /**
   * OpenRouter's non-stream failure as the SDK raises it: a 200 response whose
   * body names the logical status beside the provider's own words.
   */
  function providerCallError(logicalCode: number): Error {
    return Object.assign(new Error(`Payment Required ${PROVIDER_TEXT_MARKER}`), {
      statusCode: 200,
      responseBody: JSON.stringify({
        error: { code: logicalCode, message: PROVIDER_TEXT_MARKER },
      }),
    });
  }

  function upstreamFailure(logicalCode: number): InferenceError {
    return classifyInferenceFailure(providerCallError(logicalCode));
  }

  function capturesUnder(telemetry: Telemetry, code: string): Error[] {
    return vi
      .mocked(telemetry.captureError)
      .mock.calls.filter(([, captured]) => captured === code)
      .map(([error]) => error);
  }

  it('captures an unmapped provider failure under the provider-failure fingerprint, naming its inference code and status', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, upstreamFailure(402));

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const captured = capturesUnder(telemetry, 'inference_provider_failed');
    expect(captured).toHaveLength(1);
    const scrubbed = scrubSentryEvent(
      { type: undefined, tags: { errorCode: 'inference_provider_failed' } },
      { originalException: captured[0] }
    );
    expect(scrubbed?.tags).toEqual({
      errorCode: 'inference_provider_failed',
      inferenceCode: 'upstream_error',
      providerStatus: 402,
    });
  });

  it('reports the provider failure by its code and status alone', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, upstreamFailure(402));

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const captured = capturesUnder(telemetry, 'inference_provider_failed');
    expect(
      captured.map((error) =>
        Object.getOwnPropertyNames(error).toSorted((a, b) => a.localeCompare(b))
      )
    ).toEqual([['inferenceCode', 'message', 'name', 'providerStatus', 'stack']]);
    expect(
      captured.map((error) => [
        Reflect.get(error, 'inferenceCode'),
        Reflect.get(error, 'providerStatus'),
      ])
    ).toEqual([['upstream_error', 402]]);
  });

  it('carries none of the provider text in the capture', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, upstreamFailure(402));

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const [error] = capturesUnder(telemetry, 'inference_provider_failed');
    const surfaces = [
      error?.message,
      error?.stack,
      error?.name,
      JSON.stringify(error),
      String(error?.cause),
    ].join('\n');
    expect(surfaces).not.toContain(PROVIDER_TEXT_MARKER);
  });

  it('takes the status the failure names', async () => {
    const telemetry = fakeTelemetry();
    const failure = new InferenceError('upstream_error', 'Inference upstream error', {
      status: 503,
    });
    const exec = await freshExecution(telemetry, failure);

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const captured = capturesUnder(telemetry, 'inference_provider_failed');
    expect(captured.map((error) => Reflect.get(error, 'providerStatus'))).toEqual([503]);
  });

  it('leaves the status off a failure that carries none', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(
      telemetry,
      new InferenceError('truncated_stream', 'Stream ended without the provider finish part')
    );

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const captured = capturesUnder(telemetry, 'inference_provider_failed');
    expect(
      captured.map((error) =>
        Object.getOwnPropertyNames(error).toSorted((a, b) => a.localeCompare(b))
      )
    ).toEqual([['inferenceCode', 'message', 'name', 'stack']]);
  });

  it('reads no status off the provider error a failure wraps', async () => {
    const telemetry = fakeTelemetry();
    const failure = new InferenceError('upstream_error', 'Inference upstream error', {
      cause: Object.assign(new Error('bad gateway'), { statusCode: 502 }),
    });
    const exec = await freshExecution(telemetry, failure);

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    const captured = capturesUnder(telemetry, 'inference_provider_failed');
    expect(captured.map((error) => Object.hasOwn(error, 'providerStatus'))).toEqual([false]);
  });

  it.each([
    ['content_policy', new InferenceError('content_policy', 'refused')],
    ['context_length', new InferenceError('context_length', 'too long')],
    ['aborted', abortError()],
  ])('captures nothing for a %s failure the user caused', async (_code, failure) => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, failure);

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it('captures one of two identical failures inside one window', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, upstreamFailure(502));

    await exec.run(modelCallNode(), ['hi'], makeCtx());
    await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(capturesUnder(telemetry, 'inference_provider_failed')).toHaveLength(1);
  });

  it('captures a second failure that differs from the first by its status', async () => {
    vi.resetModules();
    const fresh = await import('./model-call-execution.js');
    const telemetry = fakeTelemetry();
    const run = (statusCode: number): Promise<unknown> =>
      fresh
        .createModelCallExecution({
          usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
          provider: throwingProvider(upstreamFailure(statusCode)),
          binding: binding(),
          schemas,
          telemetry,
        })
        .run(modelCallNode(), ['hi'], makeCtx());

    await run(502);
    await run(503);

    expect(
      capturesUnder(telemetry, 'inference_provider_failed').map((error) =>
        Reflect.get(error, 'providerStatus')
      )
    ).toEqual([502, 503]);
  });

  it('fails the node with no wire reason while reporting it', async () => {
    const telemetry = fakeTelemetry();
    const exec = await freshExecution(telemetry, upstreamFailure(402));

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrapErr()).toEqual({});
  });
});

/** A spend gate the test opens and closes, recording every running total reported to it. */
function drivenGate(): { readonly gate: SpendGate; readonly reports: bigint[]; close(): void } {
  const state = { open: true };
  const reports: bigint[] = [];
  return {
    reports,
    close: (): void => {
      state.open = false;
    },
    gate: {
      isOpen: (): boolean => state.open,
      report: (total): void => {
        reports.push(total);
      },
    },
  };
}

/** A provider whose stream the test scripts with the infer options it was handed. */
function scriptedProvider(
  script: (options: InferOptions | undefined) => AsyncGenerator<InferenceEvent>
): ModelProvider {
  return { infer: (_request, _descriptor, options) => script(options) };
}

/** The continuation a provider was handed, or the defect of a call that handed none. */
function continuationOf(
  options: InferOptions | undefined
): NonNullable<InferOptions['continuation']> {
  if (options?.continuation === undefined) throw new Error('the call handed no continuation');
  return options.continuation;
}

/** A run id in the shape the conversation room mints one. */
const CUT_RUN_ID = testUuidV7(17);

/** What the inline cost of 0.01 USD bills, at the port's conversion. */
const ONE_CENT_BILLABLE = 11_500_000n;

describe('createModelCallExecution — the spend gate before the call', () => {
  it('starts no provider call when the gate is closed', async () => {
    const infer = vi.fn(streamOf([finish(0.01)]).infer);
    const driven = drivenGate();
    driven.close();

    await runExec({ provider: { infer }, binding: binding(), schemas }).run(
      modelCallNode(),
      ['hi'],
      { ...makeCtx(), spend: driven.gate }
    );

    expect(infer).not.toHaveBeenCalled();
  });

  it('fails the node with no spend when the gate is closed', async () => {
    const driven = drivenGate();
    driven.close();

    const result = await runExec({
      provider: streamOf([finish(0.01)]),
      binding: binding(),
      schemas,
    }).run(modelCallNode(), ['hi'], { ...makeCtx(), spend: driven.gate });

    expect(result._unsafeUnwrapErr()).toEqual({});
  });

  it('emits nothing when the gate is closed', async () => {
    const emit = vi.fn();
    const driven = drivenGate();
    driven.close();

    await runExec({ provider: streamOf([finish(0.01)]), binding: binding(), schemas }).run(
      modelCallNode(),
      ['hi'],
      { ...makeCtx(emit), spend: driven.gate }
    );

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("createModelCallExecution — the tool loop asks the run's spend gate", () => {
  /** Runs one searching call whose provider runs `script`, under `gate`. */
  async function runGated(
    gate: SpendGate,
    script: (options: InferOptions | undefined) => AsyncGenerator<InferenceEvent>
  ): Promise<void> {
    await runExec({
      provider: scriptedProvider(script),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    }).run(searchingNode(), ['hi'], { ...makeCtx(), spend: gate });
  }

  it('reports the completed steps’ inline cost as the running total', async () => {
    const driven = drivenGate();

    await runGated(driven.gate, async function* script(options) {
      await Promise.resolve();
      continuationOf(options).mayStartNextStep([0.004, undefined, 0.006]);
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(driven.reports).toEqual([ONE_CENT_BILLABLE]);
  });

  it('counts the tool calls that returned into the running total', async () => {
    const driven = drivenGate();

    await runGated(driven.gate, async function* script(options) {
      await Promise.resolve();
      yield searchCall('c1');
      yield searchResult('c1');
      continuationOf(options).mayStartNextStep([0.01]);
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(driven.reports).toEqual([ONE_CENT_BILLABLE + toolCallChargeNanoUsd('webSearch', 1)]);
  });

  it('leaves a step cost that is not a usable amount out of the running total', async () => {
    const driven = drivenGate();

    await runGated(driven.gate, async function* script(options) {
      await Promise.resolve();
      continuationOf(options).mayStartNextStep([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.01]);
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(driven.reports).toEqual([ONE_CENT_BILLABLE]);
  });

  it('admits the next step while the gate is open', async () => {
    const answers: boolean[] = [];

    await runGated(drivenGate().gate, async function* script(options) {
      await Promise.resolve();
      answers.push(continuationOf(options).mayStartNextStep([0.01]));
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(answers).toEqual([true]);
  });

  it('refuses the next step once the gate has closed', async () => {
    const driven = drivenGate();
    const answers: boolean[] = [];

    await runGated(driven.gate, async function* script(options) {
      await Promise.resolve();
      driven.close();
      answers.push(continuationOf(options).mayStartNextStep([0.01]));
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(answers).toEqual([false]);
  });

  it('admits a tool call while the gate is open', async () => {
    const answers: boolean[] = [];

    await runGated(drivenGate().gate, async function* script(options) {
      await Promise.resolve();
      answers.push(continuationOf(options).mayExecuteTool());
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(answers).toEqual([true]);
  });

  it('refuses a tool call once the gate has closed', async () => {
    const driven = drivenGate();
    const answers: boolean[] = [];

    await runGated(driven.gate, async function* script(options) {
      await Promise.resolve();
      driven.close();
      answers.push(continuationOf(options).mayExecuteTool());
      yield { kind: 'text-delta', index: 0, content: 'a' };
      yield finish(0.01);
    });

    expect(answers).toEqual([false]);
  });
});

describe('createModelCallExecution — a call that ran on past a closed gate', () => {
  /** A binding whose estimate keeps a cent's inline cost inside the sanity bound. */
  const centBinding = (): ModelBinding => binding({ price: () => ok(ONE_CENT_BILLABLE) });

  it('bills a drained single-step call its inline cost exactly', async () => {
    const driven = drivenGate();
    const exec = runExec({
      provider: scriptedProvider(async function* script() {
        await Promise.resolve();
        yield { kind: 'text-delta', index: 0, content: 'partial' };
        driven.close();
        yield { kind: 'text-delta', index: 0, content: ' answer' };
        yield finish(0.01);
      }),
      binding: centBinding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), spend: driven.gate });

    expect(result._unsafeUnwrap()).toMatchObject({
      value: 'partial answer',
      costNanoUsd: ONE_CENT_BILLABLE,
      isEstimated: false,
    });
  });

  it('fails a drained loop that wrote no model text, reporting its observed spend', async () => {
    const driven = drivenGate();
    const exec = runExec({
      provider: scriptedProvider(async function* script() {
        await Promise.resolve();
        yield { kind: 'step-start', step: 0 };
        yield searchCall('c1');
        yield searchResult('c1');
        driven.close();
        yield stepFinish(0, 0.01);
        yield finish(0.01);
      }),
      binding: binding(),
      schemas,
      tools: searchLoop(),
    });

    const result = await exec.run(searchingNode(), ['hi'], { ...makeCtx(), spend: driven.gate });

    expect(result._unsafeUnwrapErr()).toEqual({
      costNanoUsd: ONE_CENT_BILLABLE + toolCallChargeNanoUsd('webSearch', 1),
    });
  });

  it('bills an empty truncation the open gate let finish', async () => {
    const exec = runExec({
      provider: streamOf([
        {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 3, outputTokens: 5 },
            finishReason: 'length',
            providerCostUsd: 0.01,
          },
        },
      ]),
      binding: centBinding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], {
      ...makeCtx(),
      spend: drivenGate().gate,
    });

    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: ONE_CENT_BILLABLE,
      isEstimated: false,
    });
  });
});

describe('createModelCallExecution — a step cut at the hard stop', () => {
  /** Step 0 completes at a cent, step 1 starts and streams text, then the hard stop cuts it. */
  function cutSecondStep(): ModelProvider {
    return throwingAfterProvider(
      [
        { kind: 'step-start', step: 0 },
        stepFinish(0, 0.01),
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'cut short' },
      ],
      abortError()
    );
  }

  it('bills the completed steps and nothing for the cut step, flagged estimated', async () => {
    const exec = runExec({ provider: cutSecondStep(), binding: binding(), schemas });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: ONE_CENT_BILLABLE,
      isEstimated: true,
    });
  });

  it('captures the cut step as absorbed, by its count', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({ provider: cutSecondStep(), binding: binding(), schemas, telemetry });

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(telemetry.captureError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'HardStopAbsorbed', cutStepCount: 1 }),
      'workflow_hard_stop_absorbed'
    );
  });

  it('captures the cut step under the id of the run it served', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({ provider: cutSecondStep(), binding: binding(), schemas, telemetry });

    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), runId: CUT_RUN_ID });

    const [error] = vi.mocked(telemetry.captureError).mock.calls.map(([captured]) => captured);
    expect(Object.getOwnPropertyNames(error).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'cutStepCount',
      'message',
      'name',
      'runId',
      'stack',
    ]);
    expect(Reflect.get(error ?? {}, 'runId')).toBe(CUT_RUN_ID);
    expect(Reflect.get(error ?? {}, 'cutStepCount')).toBe(1);
  });

  it('reaches Sentry with the run id and the cut-step count alone', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({ provider: cutSecondStep(), binding: binding(), schemas, telemetry });

    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), runId: CUT_RUN_ID });

    const [error] = vi.mocked(telemetry.captureError).mock.calls.map(([captured]) => captured);
    const scrubbed = scrubSentryEvent(
      { type: undefined, tags: { errorCode: 'workflow_hard_stop_absorbed' } },
      { originalException: error }
    );
    expect(scrubbed?.tags).toEqual({
      errorCode: 'workflow_hard_stop_absorbed',
      runId: CUT_RUN_ID,
      cutStepCount: 1,
    });
  });

  it('captures a cut step even when the call produced nothing', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'step-start', step: 0 }, stepFinish(0, 0.01), { kind: 'step-start', step: 1 }],
        abortError()
      ),
      binding: binding(),
      schemas,
      telemetry,
    });

    await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(telemetry.captureError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'HardStopAbsorbed', cutStepCount: 1 }),
      'workflow_hard_stop_absorbed'
    );
  });

  it('bills an abort between steps exactly, capturing nothing', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'step-start', step: 0 },
          { kind: 'text-delta', index: 0, content: 'whole step' },
          stepFinish(0, 0.01),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
      telemetry,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: ONE_CENT_BILLABLE,
      isEstimated: false,
    });
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('createModelCallExecution — an aborted call flags its figure by whether it is whole', () => {
  it('flags an aborted call exact when every completed step reported its cost', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'step-start', step: 0 },
          { kind: 'text-delta', index: 0, content: 'first' },
          stepFinish(0, 0.01),
          { kind: 'step-start', step: 1 },
          { kind: 'text-delta', index: 0, content: ' second' },
          stepFinish(1, 0.01),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: providerUsdToBillableNanoUsd(0.02),
      isEstimated: false,
    });
  });

  it('flags an aborted call estimated when a completed step reported no cost', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'step-start', step: 0 },
          { kind: 'text-delta', index: 0, content: 'first' },
          stepFinish(0),
          { kind: 'step-start', step: 1 },
          { kind: 'text-delta', index: 0, content: ' second' },
          stepFinish(1, 0.01),
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: ONE_CENT_BILLABLE,
      isEstimated: true,
    });
  });
});

describe('createModelCallExecution — a failed call reports its model spend', () => {
  it('reports the completed steps of an inference failure as observed spend', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'step-start', step: 0 }, stepFinish(0, 0.01)],
        new InferenceError('rate_limited', 'slow down')
      ),
      binding: binding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrapErr()).toEqual({ costNanoUsd: ONE_CENT_BILLABLE });
  });

  it('reports the completed steps of an abort that wrote nothing as observed spend', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'step-start', step: 0 }, stepFinish(0, 0.01)],
        abortError()
      ),
      binding: binding(),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrapErr()).toEqual({ costNanoUsd: ONE_CENT_BILLABLE });
  });

  it('reports the completed steps of an unpriceable run as observed spend', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: 'answer' },
        stepFinish(0),
        { kind: 'step-start', step: 1 },
        stepFinish(1, 0.01),
        finish(0.01),
      ]),
      binding: binding({ price: () => err(validationError('no rate')) }),
      schemas,
    });

    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());

    expect(result._unsafeUnwrapErr()).toEqual({ costNanoUsd: ONE_CENT_BILLABLE });
  });
});
