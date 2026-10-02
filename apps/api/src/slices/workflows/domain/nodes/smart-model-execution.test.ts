import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Node as NodeSchema, serializeSegments, textTag } from '@hushbox/shared';
import { planReasoning, reasoningPlanModelFrom } from '@hushbox/shared/affordability';
import { TEST_DAY_END, TEST_DAY_START, isoAt, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { providerUsdToBillableNanoUsd } from '../../../billing/index.js';
import { ok } from '../../../../lib/result/index.js';
import { InferenceError } from '../../../models/index.js';
import { createSmartModelExecution } from './smart-model-execution.js';
import { TURN_DECISION_SCHEMA_NAME, TurnDecision } from './turn-decision.js';
import type {
  CanonicalReasoningEffort,
  InferenceEvent,
  InferenceRequest,
  Modality,
  ModelDescriptor,
  Node,
} from '@hushbox/shared';
import type { ModelProvider } from '../../../models/index.js';
import type { NodeRunContext } from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';
import type { SmartModelExecutionDeps } from './smart-model-execution.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const CHEAP = 'cheap/model';
const HARD = 'hard/model';

/** A registered schema name beside the decision envelope's, for a two-entry registry. */
const OTHER_SCHEMA_NAME = 'attachmentRef';

function descriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function binding(id: string): ModelBinding {
  return {
    descriptor: descriptor(id),
    ports: { in: [textTag()], out: textTag() },
    // Same order of magnitude as the fixture inline costs, so the inline path
    // never trips the absurd-cost sanity bound and falls back to the estimate.
    price: () => ok(1_000_000n),
  };
}

function smartNode(overrides: Record<string, unknown> = {}): Extract<Node, { type: 'smartModel' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'smartModel',
    version: 1,
    out: 'out',
    classifierModelId: CHEAP,
    candidates: [
      { id: CHEAP, description: 'cheap and fast' },
      { id: HARD, description: 'strong reasoning' },
    ],
    params: { temperature: 0.5 },
    in: { node: 'input', port: 'prompt' },
    ...overrides,
  }) as Extract<Node, { type: 'smartModel' }>;
}

function finish(providerCostUsd: number, generationId: string): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: 'stop',
      providerCostUsd,
      generationId,
    },
  };
}

function textDelta(content: string): InferenceEvent {
  return { kind: 'text-delta', index: 0, content };
}

/** Streams per-model canned events, capturing each request in arrival order. */
function providerByModel(
  eventsByModel: Readonly<Record<string, readonly InferenceEvent[] | Error>>,
  requests: InferenceRequest[]
): ModelProvider {
  return {
    infer: (request) => {
      requests.push(request);
      const events = eventsByModel[request.model];
      return (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        if (events === undefined) throw new Error(`no canned events for ${request.model}`);
        if (events instanceof Error) throw events;
        for (const event of events) yield event;
      })();
    },
  };
}

const CHEAP_ANSWER: readonly InferenceEvent[] = [
  textDelta('cheap answer'),
  finish(0.002, 'gen-cheap'),
];
const HARD_ANSWER: readonly InferenceEvent[] = [
  textDelta('hard answer'),
  finish(0.004, 'gen-hard'),
];

function makeDeps(
  provider: ModelProvider,
  overrides: Partial<SmartModelExecutionDeps> = {}
): SmartModelExecutionDeps {
  return {
    provider,
    candidates: new Map([
      [CHEAP, binding(CHEAP)],
      [HARD, binding(HARD)],
    ]),
    schemas: { resolveSchema: vi.fn() },
    usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
    ...overrides,
  };
}

interface CtxOptions {
  readonly history?: NodeRunContext['history'];
  readonly customInstructions?: string;
}

function makeCtx(emitted: InferenceEvent[], options: CtxOptions = {}): NodeRunContext {
  return {
    values: {
      store: (value: unknown) => ok(value),
      resolve: (value: unknown) => value,
    } as unknown as NodeRunContext['values'],
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
    emit: (event): void => {
      emitted.push(event);
    },
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.customInstructions === undefined
      ? {}
      : { customInstructions: options.customInstructions }),
  };
}

/** A node whose single input port declares the decision envelope. */
function decisionNode(
  overrides: Record<string, unknown> = {}
): Extract<Node, { type: 'smartModel' }> {
  return smartNode({
    inputSchema: TURN_DECISION_SCHEMA_NAME,
    in: { node: 'decide', port: 'out' },
    ...overrides,
  });
}

/** Deps whose schema registry can resolve the decision envelope's schema name. */
function envelopeDeps(
  provider: ModelProvider,
  overrides: Partial<SmartModelExecutionDeps> = {}
): SmartModelExecutionDeps {
  return makeDeps(provider, {
    schemas: {
      resolveSchema: (name: string) =>
        name === TURN_DECISION_SCHEMA_NAME ? TurnDecision : undefined,
    },
    ...overrides,
  });
}

/** One decision envelope, as the registered reducer produces it. */
function decision(overrides: Partial<TurnDecision> = {}): TurnDecision {
  return { prompt: 'pick a model for me', modelId: CHEAP, effort: 'medium', ...overrides };
}

describe('createSmartModelExecution — the decision envelope', () => {
  it("answers on the envelope's prompt when its input port declares the decision", async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));
    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));
    expect(result.isOk()).toBe(true);
    expect(requests.at(-1)?.inputs).toEqual([{ modality: 'text', text: 'pick a model for me' }]);
  });

  it('performs NO classifier call when a decision is present — one provider call, no aux charge', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));

    // The slot consumes the decision; it never buys one. One provider call, and
    // no auxiliary charge, because no auxiliary generation happened here.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(HARD);
    expect(result._unsafeUnwrap().auxiliaryCharges ?? []).toEqual([]);
  });

  it('binds the candidate the decision carries', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(result._unsafeUnwrap().billing?.modelId).toBe(HARD);
  });

  it('throws before any provider call when the decision binds a candidate the slot does not hold', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await expect(
      execution.run(decisionNode(), [decision({ modelId: 'other/model' })], makeCtx([]))
    ).rejects.toThrow(/other\/model/);
    expect(requests).toHaveLength(0);
  });

  it('throws before any provider call when a decision reaching the slot binds no candidate', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));
    const unbound: TurnDecision = { prompt: 'pick a model for me', effort: 'medium' };

    await expect(execution.run(decisionNode(), [unbound], makeCtx([]))).rejects.toThrow(
      /binds no candidate/
    );
    expect(requests).toHaveLength(0);
  });

  it('binds its one candidate when no decision reaches the slot', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    const node = smartNode({ candidates: [{ id: HARD, description: 'strong reasoning' }] });

    const result = await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests.map((request) => request.model)).toEqual([HARD]);
    // Still badged: the chip reads "the routing pipeline ran", never "a
    // classifier billed". The display path's `isSmartModel` comment rests on this.
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('throws before any provider call when a slot with a choice of candidates is handed no decision', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));

    await expect(execution.run(smartNode(), ['prompt'], makeCtx([]))).rejects.toThrow(
      /no decision/
    );
    expect(requests).toHaveLength(0);
  });
});

/** A slot, both axes open, whose bound candidate carries a cap for Min and for Lite. */
function perRungNode(): Extract<Node, { type: 'smartModel' }> {
  return decisionNode({
    classify: { model: true, effort: true },
    candidates: [
      { id: CHEAP, description: 'cheap and fast', rungCeilings: { off: 111, lite: 99 } },
      { id: HARD, description: 'strong reasoning', rungCeilings: { off: 300, lite: 700 } },
    ],
    params: { temperature: 0.5, maxOutputTokens: 999 },
  });
}

describe('createSmartModelExecution — the bound candidate at the decided rung', () => {
  it('runs the bound candidate at its cap for the decided rung', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(perRungNode(), [decision({ modelId: HARD, effort: 'lite' })], makeCtx([]));

    expect(requests[0]?.parameters['maxOutputTokens']).toBe(700);
  });

  it('runs the bound candidate at its cap for a lower decided rung', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(perRungNode(), [decision({ modelId: HARD, effort: 'off' })], makeCtx([]));

    expect(requests[0]?.parameters['maxOutputTokens']).toBe(300);
  });

  it('throws before any provider call when the bound candidate has no cap for the decided rung', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));
    const node = decisionNode({
      classify: { model: true, effort: true },
      candidates: [
        { id: CHEAP, description: 'cheap and fast', rungCeilings: { off: 111, lite: 99 } },
        { id: HARD, description: 'strong reasoning', rungCeilings: { off: 300 } },
      ],
    });

    await expect(
      execution.run(node, [decision({ modelId: HARD, effort: 'lite' })], makeCtx([]))
    ).rejects.toThrow(/no cap/);
    expect(requests).toHaveLength(0);
  });
});

describe('createSmartModelExecution — the bound answer call', () => {
  it('sends the answer call the full run history and the node params, streaming its events', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(envelopeDeps(provider));
    const history = [
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' },
    ];

    await execution.run(
      decisionNode(),
      [decision({ prompt: 'follow-up', modelId: HARD })],
      makeCtx(emitted, { history })
    );

    const answerRequest = requests[0];
    expect(answerRequest?.model).toBe(HARD);
    expect(answerRequest?.inputs).toEqual([{ modality: 'text', text: 'follow-up' }]);
    expect(answerRequest?.parameters).toEqual({ temperature: 0.5 });
    expect(answerRequest?.history).toEqual(history);
    // The bound answer is the ONLY generation this node runs, and it labels the
    // stream with the model it bound.
    expect(emitted).toEqual([{ kind: 'stream-start', modelId: HARD }, ...HARD_ANSWER]);
    expect(emitted.filter((event) => event.kind === 'stream-start')).toHaveLength(1);
  });

  it('threads run-scoped custom instructions onto the answer request', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(
      decisionNode(),
      [decision({ modelId: HARD })],
      makeCtx([], { customInstructions: 'answer in French' })
    );

    expect(requests[0]?.customInstructions).toBe('answer in French');
    expect(requests[0]?.parameters).toEqual({ temperature: 0.5 });
  });

  it('omits custom instructions from the answer request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(requests[0]).not.toHaveProperty('customInstructions');
    expect(requests[0]?.parameters).toEqual({ temperature: 0.5 });
  });

  it("takes the answer request's day from the run's engine clock", async () => {
    // Non-epoch, so a constant substituted for the clock read renders a different
    // day; and the last millisecond of a UTC day, the point at which a key derived
    // from anything but the UTC date is likeliest to differ.
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(decisionNode(), [decision({ modelId: HARD })], {
      ...makeCtx([]),
      clock: { now: () => TEST_DAY_END },
    });

    expect(requests[0]?.utcDay).toBe(isoAt(TEST_DAY_END).slice(0, 10));
  });

  it('normalizes an empty run history to a history-free answer request', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    await execution.run(
      decisionNode(),
      [decision({ modelId: HARD })],
      makeCtx([], { history: [] })
    );

    expect(requests[0]).not.toHaveProperty('history');
  });

  it("applies the bound candidate's OWN admission-stamped cap over the node params", async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(envelopeDeps(provider));
    const node = decisionNode({
      candidates: [
        { id: CHEAP, description: 'cheap and fast', maxOutputTokens: 111 },
        { id: HARD, description: 'strong reasoning', maxOutputTokens: 222 },
      ],
      params: { temperature: 0.5, maxOutputTokens: 999 },
    });

    await execution.run(node, [decision({ modelId: HARD })], makeCtx([]));

    expect(requests[0]?.parameters['maxOutputTokens']).toBe(222);
  });

  it('serializes the answer value with streamed reasoning intact (same-field doctrine)', async () => {
    const provider = providerByModel(
      {
        [HARD]: [
          { kind: 'reasoning-delta', index: 0, content: 'thinking…' },
          textDelta('the answer'),
          finish(0.004, 'gen-hard'),
        ],
      },
      []
    );
    const execution = createSmartModelExecution(envelopeDeps(provider));

    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(result._unsafeUnwrap().value).toBe(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'thinking…' }] },
        { kind: 'text', text: 'the answer' },
      ])
    );
  });

  it('badges a model-routing turn with smartModelRan', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(envelopeDeps(provider));

    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('badges the single-candidate slot — the routing pipeline still ran (legacy parity)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    const node = decisionNode({ candidates: [{ id: CHEAP, description: 'cheap and fast' }] });

    const result = await execution.run(node, [decision()], makeCtx([]));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(CHEAP);
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('throws a defect when the bound candidate has no binding (broken wiring)', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    await expect(
      execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]))
    ).rejects.toThrow(/no binding for resolved candidate/);
  });

  it('fails as an ordinary node failure on a non-text input', async () => {
    const provider = providerByModel({}, []);
    const execution = createSmartModelExecution(makeDeps(provider));
    const result = await execution.run(smartNode(), [42], makeCtx([]));
    expect(result.isErr()).toBe(true);
  });
});

/** A reasoning-capable descriptor: effort-native (null = full ladder). */
function reasoningBinding(id: string): ModelBinding {
  const base = binding(id);
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 200_000 },
    },
  };
}

/**
 * What the reasoning binding's own ladder spends at a rung, read through the
 * published plan producer: the budget table itself is money-layer machinery and
 * stays behind the wall, and asking the producer pins the figure the node under
 * test actually carves its cap against.
 */
function budgetTokensAt(effort: CanonicalReasoningEffort): number {
  const planned = planReasoning(
    reasoningPlanModelFrom(reasoningBinding(HARD).descriptor),
    effort,
    1
  );
  if (!planned.feasible) throw new Error(`the reasoning binding offers no '${effort}' rung`);
  return planned.plan.reasoningBudgetTokens;
}

const ANSWER_CAP = budgetTokensAt('high') + 10_000;

/** A single-candidate pinned+auto node: the effort dimension only. */
function pinnedAutoNode(
  overrides: Record<string, unknown> = {}
): Extract<Node, { type: 'smartModel' }> {
  return decisionNode({
    candidates: [{ id: HARD, description: 'strong reasoning' }],
    classify: { model: false, effort: true },
    params: { maxOutputTokens: ANSWER_CAP },
    ...overrides,
  });
}

function pinnedAutoDeps(
  provider: ModelProvider,
  overrides: Partial<SmartModelExecutionDeps> = {}
): SmartModelExecutionDeps {
  return envelopeDeps(provider, {
    candidates: new Map([[HARD, reasoningBinding(HARD)]]),
    ...overrides,
  });
}

describe('createSmartModelExecution — the effort axis', () => {
  it("pinned + auto: the decision's level rides the answer wire, cap unchanged, NOT badged", async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    const result = await execution.run(
      pinnedAutoNode(),
      [decision({ prompt: 'prove a theorem', modelId: HARD, effort: 'high' })],
      makeCtx([])
    );
    const success = result._unsafeUnwrap();

    // One generation: the answer. The decided level rides it as the plan's wire,
    // and the completion cap stays the built (already-reserved) cap.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(HARD);
    expect(requests[0]?.parameters['reasoning']).toEqual({ effort: 'high' });
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
    // The turn is NOT badged Smart Model — the user pinned the model.
    expect(success.smartModelRan).toBeUndefined();
  });

  it('resolves both axes from one decision (Smart Model + auto), badged', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = decisionNode({
      classify: { model: true, effort: true },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    const result = await execution.run(
      node,
      [decision({ modelId: HARD, effort: 'medium' })],
      makeCtx([])
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(HARD);
    expect(requests[0]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('records the level the answer call resolved to', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = decisionNode({
      classify: { model: true, effort: true },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    const result = await execution.run(
      node,
      [decision({ modelId: HARD, effort: 'medium' })],
      makeCtx([])
    );

    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBe('medium');
  });

  it('invents no effort of its own when the slot was handed no decision', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));
    // A raw-text port: no decision reached the slot, which means no classifier
    // ran for it. §Reasoning Effort 5 forbids a silent static level in that
    // case, and the ONE declared fallback lives in the reducer — the only place
    // that knows the axis's cheapest option. So the built params ride unchanged
    // rather than a second fallback answering the same question here.
    const node = pinnedAutoNode({ inputSchema: undefined, in: { node: 'input', port: 'prompt' } });

    await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
  });

  it('leaves the answer params untouched when the bound candidate is not reasoning-capable', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = decisionNode({
      classify: { model: true, effort: true },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    await execution.run(node, [decision({ modelId: CHEAP, effort: 'high' })], makeCtx([]));

    expect(requests[0]?.model).toBe(CHEAP);
    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('runs reasoning-free when the node carries no completion cap (no cap, no budget wire)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    await execution.run(
      pinnedAutoNode({ params: {} }),
      [decision({ modelId: HARD, effort: 'high' })],
      makeCtx([])
    );

    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
  });

  it('steps the decided level down when its budget cannot fit the built completion cap', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));
    // A cap with no headroom above the high budget: the nearest feasible offered
    // level below (medium) wins; the cap itself never grows.
    const node = pinnedAutoNode({
      params: { maxOutputTokens: budgetTokensAt('high') },
    });

    await execution.run(node, [decision({ modelId: HARD, effort: 'high' })], makeCtx([]));

    expect(requests[0]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(budgetTokensAt('high'));
  });

  it('leaves the built params alone when neither axis is open for this node', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    // Neither axis declared: the decision carries an effort, and the node must
    // not apply it — a closed axis is the user's own pinned choice.
    const node = decisionNode({
      candidates: [{ id: CHEAP, description: 'cheap and fast' }],
      classify: { model: false, effort: false },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    await execution.run(node, [decision({ modelId: CHEAP, effort: 'max' })], makeCtx([]));

    expect(requests[0]?.model).toBe(CHEAP);
    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
  });

  it("runs the node's pinned level when the effort axis is closed, ignoring the decision's", async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, { candidates: new Map([[HARD, reasoningBinding(HARD)]]) })
    );
    // The routing turn a user pinned a level on: the classifier answers the
    // model axis only, and the level is the user's own — so the decision's
    // effort is not the axis's answer here, the node's pin is.
    const node = decisionNode({
      candidates: [{ id: HARD, description: 'strong reasoning' }],
      pinnedEffort: 'high',
      params: { maxOutputTokens: ANSWER_CAP },
    });

    await execution.run(node, [decision({ modelId: HARD, effort: 'medium' })], makeCtx([]));

    expect(requests[0]?.parameters['reasoning']).toEqual({ effort: 'high' });
  });
});

/** A hard-off ("none") composite node: the built off wire is shared node data. */
function hardOffNode(): Extract<Node, { type: 'smartModel' }> {
  return decisionNode({
    params: { maxOutputTokens: ANSWER_CAP, reasoning: { enabled: false } },
  });
}

describe('createSmartModelExecution — hard-off wire ("none" composite turn)', () => {
  it('sends the explicit off wire to a reasoning-capable non-mandatory bound candidate', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );

    await execution.run(hardOffNode(), [decision({ modelId: HARD })], makeCtx([]));

    // Hard off, never omission — the cap stays plain-turn sized.
    expect(requests[0]?.model).toBe(HARD);
    expect(requests[0]?.parameters['reasoning']).toEqual({ enabled: false });
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('records `off` for the candidate that kept the explicit off wire', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );

    const result = await execution.run(hardOffNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBe('off');
  });

  it('records no level for the candidate the off wire was stripped from', async () => {
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, []);
    const mandatory: ModelBinding = {
      ...reasoningBinding(HARD),
      descriptor: {
        ...reasoningBinding(HARD).descriptor,
        reasoning: { supportedEfforts: null, mandatory: true },
      },
    };
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, mandatory],
        ]),
      })
    );

    const result = await execution.run(hardOffNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(result._unsafeUnwrap().billing?.reasoningEffort).toBeUndefined();
  });

  it('strips the off wire when the bound candidate has MANDATORY reasoning (cannot disable)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const mandatory: ModelBinding = {
      ...reasoningBinding(HARD),
      descriptor: {
        ...reasoningBinding(HARD).descriptor,
        reasoning: { supportedEfforts: null, mandatory: true },
      },
    };
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, mandatory],
        ]),
      })
    );

    await execution.run(hardOffNode(), [decision({ modelId: HARD })], makeCtx([]));

    expect(requests[0]?.model).toBe(HARD);
    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
    expect(requests[0]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('passes a non-off reasoning param through untouched (only the off wire is per-candidate)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = decisionNode({
      params: { maxOutputTokens: ANSWER_CAP, reasoning: { effort: 'low' } },
    });

    await execution.run(node, [decision({ modelId: HARD })], makeCtx([]));

    expect(requests[0]?.parameters['reasoning']).toEqual({ effort: 'low' });
  });

  it('strips the off wire when the bound candidate is not reasoning-capable', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(
      envelopeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    const node = decisionNode({
      candidates: [{ id: CHEAP, description: 'cheap and fast' }],
      params: { maxOutputTokens: ANSWER_CAP, reasoning: { enabled: false } },
    });

    await execution.run(node, [decision()], makeCtx([]));

    expect(requests[0]?.parameters['reasoning']).toBeUndefined();
  });
});

describe('createSmartModelExecution — remaining failure edges', () => {
  it('fails the node when the answer call itself fails', async () => {
    const provider: ModelProvider = {
      infer: (request) =>
        (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (request.model !== '') {
            throw new InferenceError('upstream_error', `${request.model} down`);
          }
          yield textDelta('unreachable');
        })(),
    };
    const execution = createSmartModelExecution(envelopeDeps(provider));

    const result = await execution.run(decisionNode(), [decision({ modelId: HARD })], makeCtx([]));
    expect(result.isErr()).toBe(true);
  });

  it('fails the node when its declared input schema carries something that is not a prompt', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER, [HARD]: HARD_ANSWER }, requests);
    // A second registered schema is all it takes: the port validates, and what
    // arrives on it is neither the decision envelope nor raw text.
    const registered = new Map<string, z.ZodType>([
      [TURN_DECISION_SCHEMA_NAME, TurnDecision],
      [OTHER_SCHEMA_NAME, z.object({ note: z.string() })],
    ]);
    const execution = createSmartModelExecution(
      makeDeps(provider, { schemas: { resolveSchema: (name) => registered.get(name) } })
    );

    const result = await execution.run(
      smartNode({ inputSchema: OTHER_SCHEMA_NAME, in: { node: 'attach', port: 'out' } }),
      [{ note: 'not a prompt' }],
      makeCtx([])
    );

    expect(result.isErr()).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
