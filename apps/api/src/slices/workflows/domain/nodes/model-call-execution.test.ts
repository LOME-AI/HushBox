import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  Node as NodeSchema,
  mediaTag,
  optionalTag,
  parseAssistantMessage,
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
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import { TEST_DAY_END, TEST_DAY_START, isoAt, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { providerUsdToBillableNanoUsd } from '../../../billing/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { scrubSentryEvent } from '../../../../lib/telemetry/adapters/sentry-scrub.js';
import { createValueStore } from '../engine/value-store.js';
import { InferenceError, priceUsageBillableNanoUsd } from '../../../models/index.js';
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
import type { EngineClock, NodeRunContext, NodeRunSuccess } from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';

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

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    descriptor: descriptor(),
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(50n),
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

/** A stop/deadline abort surfaces as the adapters' InferenceError code 'aborted'. */
function abortError(): InferenceError {
  return new InferenceError('aborted', 'Inference aborted: user stop');
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

  it('bills an image generation at the deterministic media estimate with isEstimated true and never alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(), // image carries no inline cost by design
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
      costNanoUsd: 50n,
      isEstimated: true,
      // Image always records a count dimension (defaults to 1) for media_generations.
      billing: {
        modelId: 'answer-model',
        providerName: SERVED_BY_UNREPORTED,
        modality: 'image',
        media: { imageCount: 1 },
      },
    });
    expect(telemetry.captureError).not.toHaveBeenCalled();
    expect(telemetry.warn).not.toHaveBeenCalled();
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

  it('bounds a video inline cost against the deterministic media estimate, not the token estimate', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // 1000 USD is far beyond 1000× the 70n media estimate — clearly corrupt.
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish(1000)]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
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

describe('createModelCallExecution — a stopped searching run settles its partial', () => {
  it('bills the partial inline cost plus the searches that returned before the stop', async () => {
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

  it('bills zero plus the returned searches when the stopped partial observed no model cost', async () => {
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

  it('bills the media estimate plus the returned searches for a stopped media partial', async () => {
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

  it('fails a stop that streamed nothing, reporting its search spend as observed and charging nothing', async () => {
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

  it('persists nothing for a stop after only searches, with no model text', async () => {
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

  it('stores a search in flight at a stop as interrupted and does not bill it', async () => {
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

describe('createModelCallExecution — stop/deadline abort settles the streamed partial', () => {
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

  it('fails the node on abort when nothing accumulated (empty stop bills nothing)', async () => {
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
        finish(), // image carries no inline cost by design
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
 * event is handled; `abortAtMs` ends the stream with a stop at that instant.
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

  it('settles a stop inside reasoning with the time up to its last reasoning delta', async () => {
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
