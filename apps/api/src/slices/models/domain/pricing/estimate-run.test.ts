import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_FRAMING_MAX_CHARS,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  TURN_DECISION_REDUCER,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  WEB_SEARCH_ROW_MAX_CHARS,
  WorkflowDefinition,
} from '@hushbox/shared';
import {
  WEB_SEARCH_RESULT_MAX_CHARS,
  inputTokensOf,
  toolCallBillableNano,
  toolCallCapFor,
  toolLoopBound,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import {
  classifierReserveChars,
  classifierWorstCaseNanoUsd,
} from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { ceilingOf } from '@hushbox/shared/affordability/price/schedule';
import { tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { DAILY_ALLOWANCE_NANO_USD } from '../../../billing/index.js';

import {
  createEstimateRun as createReservation,
  estimateMinMediaOutputBytes,
  mediaTurnMinCostNanoUsd,
} from './estimate-run.js';
import { buildSmartModelCandidates, smartModelMinimumNanoUsd } from '../smart-model/candidates.js';
import type { NanoUSD, ModelDescriptor, UserTier } from '@hushbox/shared';
import type { RunReservation } from '@hushbox/shared/affordability/price/reservation';
import type { ModelPricingResolver } from './estimate-run.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';

/**
 * The admission ceiling estimator prices a definition's declared worst case:
 * each modelCall's per-token ceiling (input+output at the model's full
 * context window) multiplied by its enclosing fanOut width and loop
 * iterations, summed across every model node. Over-estimation is the point —
 * a hold must never under-reserve — so these expectations assert the ceiling,
 * not an expected-value.
 */

const TOKEN_PRICING: ModelDescriptor['pricing'] = tokenPricingFixture({
  input: 2500n,
  output: 10_000n,
});

/** A fixed instant: premium classification takes its clock as an argument. */
const SMART_NOW_MS = TEST_DAY_START;

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * contextLength 1000 priced on BOTH legs at the hold's ceiling rates, five
 * quarters of 2,500 / 10,000: 1000×3125 + 1000×12_500 = 15_625_000.
 */
const BASE_1000 = 15_625_000n;

/** The classifier reserve a token-priced model would hold over `prompted`. */
function classifierReserveOf(
  model: ModelDescriptor,
  prompted: readonly { readonly id: string }[]
): bigint {
  const pricing = tokenPricingOf(model.pricing);
  if (pricing === undefined) throw new TypeError('expected a token-priced classifier');
  return classifierWorstCaseNanoUsd({ pricing }, prompted);
}

function buildDescriptor(params: {
  readonly id: string;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: ModelDescriptor['pricing'];
}): ModelDescriptor {
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {
      ...(params.contextLength === undefined ? {} : { contextLength: params.contextLength }),
      ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    },
    pricing: params.pricing ?? TOKEN_PRICING,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

/**
 * The reservation's total, read after checking that its calls account for all
 * of it and that an untiered price reserves every step at base. Every case that
 * reads a total through this checks the reservation it came from.
 */
function totalOf(reservation: RunReservation): NanoUSD {
  const held = reservation.calls.reduce((sum, call) => sum + call.heldNanoUsd, 0n);
  expect(held).toBe(reservation.totalNanoUsd);
  for (const call of reservation.calls) {
    if (call.pricing.kind === 'tokens' && call.pricing.anchor.tiers.length === 0) {
      expect(call.stepTiers.every((tier) => tier === 0)).toBe(true);
    }
  }
  return reservation.totalNanoUsd;
}

/** The estimator read as its total, through {@link totalOf}. */
function createEstimateRun(
  resolveModel: ModelPricingResolver
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createReservation(resolveModel);
  return (definition) => reserve(definition).map((reservation) => totalOf(reservation));
}

function resolverOf(...descriptors: readonly ModelDescriptor[]): ModelPricingResolver {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return (id) => byId.get(id);
}

function modelNode(id: string, model: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'modelCall',
    model,
    params: {},
    in: { node: 'src', port: 'out' },
    ...extra,
  };
}

function fanOutNode(id: string, body: string, maxWidth: number): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'fanOut',
    over: { node: 'src', port: 'out' },
    body,
    maxWidth,
  };
}

function loopNode(id: string, body: string, maxIterations: number): unknown {
  return { id, version: 1, out: 'out', type: 'loop', body, until: 'done', maxIterations };
}

function branchNode(id: string, cases: Record<string, string>, els: string): unknown {
  return { id, version: 1, out: 'out', type: 'branch', predicate: 'p', cases, else: els };
}

function transformNode(id: string): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'transform',
    transform: 't',
    in: { node: 'src', port: 'out' },
  };
}

function subWorkflowNode(id: string, ref: string): unknown {
  return { id, version: 1, out: 'out', type: 'subWorkflow', ref };
}

function smartModelNode(
  id: string,
  classifierModelId: string,
  candidateIds: readonly string[],
  extra: Record<string, unknown> = {}
): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'smartModel',
    classifierModelId,
    candidates: candidateIds.map((candidateId) => ({ id: candidateId })),
    in: { node: 'input', port: 'prompt' },
    ...extra,
  };
}

function fanInNode(
  id: string,
  reducer: string,
  ins: readonly { readonly node: string; readonly port: string }[]
): unknown {
  return { id, version: 1, out: 'out', type: 'fanIn', reducer, ins };
}

/**
 * `edges` is what makes a node's output consumed, so the fixtures that assert
 * an output-storage reserve declare theirs; the rest price provider cost alone,
 * where consumption cannot change the number.
 */
function workflow(
  nodes: readonly unknown[],
  storage?: { readonly inputChars: number },
  edges: readonly unknown[] = []
): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat', settlement: 'chat' },
    nodes,
    edges,
    ...(storage === undefined ? {} : { storage }),
  });
}

function edge(fromNode: string, fromPort: string, toNode: string, toPort: string): unknown {
  return { from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

describe('estimateRun at one input ratio and one stored-output ratio', () => {
  /** Sonnet 4.5's stored billable rates: a 64,000-token cap inside a 1,000,000-token window. */
  const SONNET = buildDescriptor({
    id: 'sonnet',
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: tokenPricingFixture({ input: 3450n, output: 17_250n }),
  });

  it('holds 1,827 prompt characters and a full 64,000-token answer at 1,478,877,017 nano', () => {
    const estimateRun = createEstimateRun(resolverOf(SONNET));

    const hold = estimateRun(
      workflow(
        [
          modelNode('m1', 'sonnet', {
            promptInputTokens: inputTokensOf(1827),
            params: { maxOutputTokens: 64_000 },
          }),
        ],
        { inputChars: 88 }
      )
    )._unsafeUnwrap();

    // At the ceiling, five quarters of 3,450 / 17,250 rounded up: 609 input
    // tokens × 4,313 + 64,000 × (21,563 + 1,500 output storage)
    // + 640 framing characters × 300 + 88 new characters × 300.
    expect(hold).toBe(1_478_877_017n);
  });
});

describe('estimateRun on a long-context tier', () => {
  /** Sonnet 4.5's anchor: base rates, and dearer rates once a request passes 200,000 prompt tokens. */
  const TIERED_SONNET: ModelDescriptor = {
    ...buildDescriptor({ id: 'sonnet', contextLength: 1_000_000, maxOutputTokens: 64_000 }),
    pricing: tokenPricingFixture({
      input: 3450n,
      output: 17_250n,
      tiers: [{ abovePromptTokens: 200_000, input: 6900n, output: 25_875n }],
    }),
  };

  it('reserves a 293,334-token prompt and a 64,000-token answer at the tier, 4,696,240,150 nano', () => {
    const reservation = createReservation(resolverOf(TIERED_SONNET))(
      workflow(
        [
          modelNode('m1', 'sonnet', {
            promptInputTokens: inputTokensOf(880_000),
            params: { maxOutputTokens: 64_000 },
          }),
        ],
        { inputChars: 88 }
      )
    )._unsafeUnwrap();

    // At the tier's ceiling, five quarters of 6,900 / 25,875 rounded up:
    // 293,334 × 8,625 + 64,000 × (32,344 + 1,500 output storage)
    // + 640 framing characters × 300 + 88 new characters × 300.
    expect(reservation.totalNanoUsd).toBe(4_696_240_150n);
    expect(reservation.calls.map((call) => call.stepTiers)).toEqual([[1]]);
  });

  it('reserves no less than the anchor-tier bill of 220,000 input and 64,000 output tokens', () => {
    const reservation = createReservation(resolverOf(TIERED_SONNET))(
      workflow(
        [
          modelNode('m1', 'sonnet', {
            promptInputTokens: inputTokensOf(880_000),
            params: { maxOutputTokens: 64_000 },
          }),
        ],
        { inputChars: 88 }
      )
    )._unsafeUnwrap();

    // 220,000 × 6,900 + 64,000 × 25,875 + 256,000 stored characters × 300.
    const anchorTierBill = 3_250_826_400n;
    expect(reservation.totalNanoUsd >= anchorTierBill).toBe(true);
  });
});

describe('estimateRun on a stamped definition with no billable call', () => {
  it('still reserves the new message’s input storage: 88 chars × 300 nano', () => {
    const reserve = createReservation(resolverOf());

    const reservation = reserve(
      workflow([transformNode('t1')], { inputChars: 88 })
    )._unsafeUnwrap();

    // There is no call to carry it, so the hold is the input storage alone.
    expect(reservation.totalNanoUsd).toBe(26_400n);
    expect(reservation.calls).toEqual([]);
  });
});

describe('estimateRun', () => {
  it('prices a single modelCall at that model context-window ceiling', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('multiplies a model node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 3n);
  });

  it('does not multiply a fanOut of width one', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 1), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('multiplies a model node by its enclosing loop declared max iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([loopNode('l1', 'm1', 4), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 4n);
  });

  it('prices a node that carries no tool at one call, whatever steps it declares', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // Only a tool loop takes more than one step, so a tool-free node's steps
    // multiply nothing.
    const result = estimateRun(workflow([modelNode('m1', 'gpt', { maxSteps: 2 })]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('caps the output leg at a declared maxOutputTokens param, shrinking the hold', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const capped = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 400 } })])
    );
    const uncapped = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // input leg stays the full context; output leg = min(1000, 400):
    // 1000×3125 + 400×12_500 = 8_125_000.
    expect(capped._unsafeUnwrap()).toBe(8_125_000n);
    expect(capped._unsafeUnwrap() < uncapped._unsafeUnwrap()).toBe(true);
  });

  it('never raises the output leg above the context window when the declared cap exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 5000 } })])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('bounds the output leg at the catalog maxOutputTokens limit with no declared param', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // The capped model reserves less than the full-context worst case:
    // input leg 1000×3125 + output leg min(1000, 300)×12_500 = 6_875_000.
    expect(result._unsafeUnwrap()).toBe(6_875_000n);
    expect(result._unsafeUnwrap() < BASE_1000).toBe(true);
  });

  it('bounds a declared maxOutputTokens param above the catalog limit at the limit', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 800 } })])
    );

    expect(result._unsafeUnwrap()).toBe(6_875_000n);
  });

  it('keeps a declared maxOutputTokens param below the catalog limit (tightest wins)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 200 } })])
    );

    expect(result._unsafeUnwrap()).toBe(5_625_000n);
  });

  it('never raises the output leg above the context window when the catalog limit exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 5000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('bounds the input leg at the stamped promptInputTokens, shrinking the hold', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const bounded = estimateRun(workflow([modelNode('m1', 'gpt', { promptInputTokens: 200 })]));
    const unbounded = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // input leg = min(1000, 200) = 200; output leg stays the full context:
    // 200×3125 + 1000×12_500 = 13_125_000.
    expect(bounded._unsafeUnwrap()).toBe(13_125_000n);
    expect(bounded._unsafeUnwrap() < unbounded._unsafeUnwrap()).toBe(true);
  });

  it('never raises the input leg above the context window when promptInputTokens exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { promptInputTokens: 9999 })]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['non-numeric', '400'],
  ])('falls back to the full-context output leg for a %s maxOutputTokens param', (_label, bad) => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: bad } })])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('multiplies by the product of nested fanOut width and loop iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // fanOut(width 2) → loop(iters 3) → modelCall  ⇒ ceiling ×6.
    const result = estimateRun(
      workflow([fanOutNode('f1', 'l1', 2), loopNode('l1', 'm1', 3), modelNode('m1', 'gpt')])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 6n);
  });

  it('inherits an enclosing fanOut through a branch and sums the branch targets', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({ id: 'claude', contextLength: 1000 })
      )
    );

    // fanOut(width 2) → branch{a: m1, else: 'end'} plus a second case m2.
    const result = estimateRun(
      workflow([
        fanOutNode('f1', 'b1', 2),
        branchNode('b1', { a: 'm1', b: 'm2' }, 'end'),
        modelNode('m1', 'gpt'),
        modelNode('m2', 'claude'),
      ])
    );

    // Both branch targets ride the fanOut ×2, branch itself adds nothing.
    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 2n + BASE_1000 * 2n);
  });

  it('sums the ceilings of every model node in the definition', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({
          id: 'claude',
          contextLength: 500,
          pricing: tokenPricingFixture({ input: 1000n, output: 2000n }),
        })
      )
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt'), modelNode('m2', 'claude')]));

    // gpt: 15_625_000 ; claude at the ceiling of 1,000 / 2,000:
    // 500×1250 + 500×2500 = 1_875_000.
    expect(result._unsafeUnwrap()).toBe(BASE_1000 + 1_875_000n);
  });

  it('adds the worst-case web-search reservation to a modelCall that enabled the search tool', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // A web-search modelCall carries `tools: ['webSearch']` and the loop's step
    // ceiling. Admission holds the model's whole tool loop at the context-window
    // ceiling, so the turn is refused up front when it cannot afford it, rather
    // than admitted on a hold its tool loop outruns.
    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { tools: ['webSearch'], maxSteps: 11 })], NO_NEW_INPUT)
    );

    expect(result._unsafeUnwrap()).toBe(toolLoopOracle(gptLoop(11)));
  });

  it('exceeds the same turn without web search by exactly the reservation (admission refuses a balance between them)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const withSearch = estimateRun(
      workflow([modelNode('m1', 'gpt', { tools: ['webSearch'], maxSteps: 11 })], NO_NEW_INPUT)
    )._unsafeUnwrap();
    const withoutSearch = estimateRun(
      workflow([modelNode('m1', 'gpt')], NO_NEW_INPUT)
    )._unsafeUnwrap();

    // Admission refuses when balance < estimate, so a wallet holding exactly the
    // no-search estimate cannot afford the web-search run — refused pre-flight.
    expect(withSearch - withoutSearch).toBe(
      toolLoopOracle(gptLoop(11)) - plainCallOracle(gptLoop(11))
    );
    expect(withSearch > withoutSearch).toBe(true);
  });

  it('reserves the search worst case per web-search model node (N models → N reservations)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({ id: 'claude', contextLength: 1000 })
      )
    );

    const result = estimateRun(
      workflow(
        [
          modelNode('m1', 'gpt', { tools: ['webSearch'], maxSteps: 11 }),
          modelNode('m2', 'claude', { tools: ['webSearch'], maxSteps: 11 }),
        ],
        NO_NEW_INPUT
      )
    );

    // Each sibling could run its whole loop, so each reserves it.
    expect(result._unsafeUnwrap()).toBe(2n * toolLoopOracle(gptLoop(11)));
  });

  it('adds no search reservation to a modelCall with no tools declared', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { tools: [] })]));

    // Web search off ⇒ the ceiling is unchanged (no search term).
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('scales the web-search reservation by an enclosing fanOut width and loop iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // fanOut(width 2) → loop(iters 3) → web-search modelCall ⇒ the whole loop
    // ×6: each fanned/looped invocation can run its loop to the cap.
    const result = estimateRun(
      workflow(
        [
          fanOutNode('f1', 'l1', 2),
          loopNode('l1', 'm1', 3),
          modelNode('m1', 'gpt', { tools: ['webSearch'], maxSteps: 11 }),
        ],
        NO_NEW_INPUT
      )
    );

    expect(result._unsafeUnwrap()).toBe(toolLoopOracle(gptLoop(11)) * 6n);
  });

  it('reserves the search allowance once for a classified turn, not once per model call', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // The shape an automatic-effort web-search turn compiles to: an unarmed
    // classifier call beside the tool-carrying answer it decides for. Only the
    // answer searches, so the whole turn reserves one loop however many model
    // calls it holds.
    const classified = workflow(
      [
        modelNode('classify', 'gpt', { tools: [], maxSteps: 1 }),
        fanInNode('decide', TURN_DECISION_REDUCER, [
          { node: 'input', port: 'prompt' },
          { node: 'classify', port: 'out' },
        ]),
        modelNode('answer', 'gpt', { tools: ['webSearch'], maxSteps: 11 }),
      ],
      NO_NEW_INPUT
    );
    // A one-call turn shows one reservation whatever the multiplier is, so the
    // delta below says nothing unless two calls are in the fixture.
    const calls = classified.nodes.filter((node) => node.type === 'modelCall');
    if (calls.length !== 2) {
      throw new Error('expected a classified turn: the classifier call beside the answer');
    }

    // Measured against the SAME definition with `tools` emptied on every call,
    // so both ceilings, the reducer and the enclosure are identical by
    // construction and only the loop moves. Emptying every call, not just the
    // answer, is what pins the multiplier: a change that armed the classifier
    // too would show a second loop in this delta.
    const withSearch = estimateRun(classified)._unsafeUnwrap();
    const searchFree = estimateRun({
      ...classified,
      nodes: classified.nodes.map((node) =>
        node.type === 'modelCall' ? { ...node, tools: [] } : node
      ),
    })._unsafeUnwrap();

    expect(withSearch - searchFree).toBe(
      toolLoopOracle(gptLoop(11)) - plainCallOracle(gptLoop(11))
    );
  });

  it('ignores non-model nodes when summing', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([transformNode('t1'), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('prices a smartModel node at the bounded classifier reserve plus the MAX candidate ceiling', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(
      resolverOf(
        cheap,
        buildDescriptor({ id: 'mid', contextLength: 2000 }),
        buildDescriptor({ id: 'big', contextLength: 4000 })
      )
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'mid', 'big'])]));

    // The classifier is priced at its bounded truncated-context reserve (the
    // affordability filter's basis), NOT a full-context modelCall. Exactly ONE
    // candidate answers, so the ceiling is classifier + max candidate.
    const classifierReserve = classifierReserveOf(cheap, [
      { id: 'cheap' },
      { id: 'mid' },
      { id: 'big' },
    ]);
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 4n);
  });

  it('holds NO internal classifier reserve for a slot fed the decision from outside', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // A slot declaring an input schema reads a decision produced elsewhere, so
    // the turn-level classifier node is what is priced — pricing a reserve here
    // too would hold for one call twice.
    const external = estimateRun(
      workflow([smartModelNode('s1', 'cheap', ['cheap', 'cheap'], { inputSchema: 'turnDecision' })])
    );
    const internal = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'cheap'])]));
    const reserve = classifierReserveOf(cheap, [{ id: 'cheap' }, { id: 'cheap' }]);

    expect(external._unsafeUnwrap()).toBe(BASE_1000);
    expect(internal._unsafeUnwrap()).toBe(BASE_1000 + reserve);
    expect(reserve).toBeGreaterThan(0n);
  });

  it('holds NO classifier reserve for a single-candidate model-only node (short-circuit never bills)', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap'])]));

    // One candidate, model dimension only: the execution short-circuits with
    // zero classifier generations, so admission reserves the candidate alone.
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('reserves only the affordable subset end to end: a low-balance wallet prices cheap, never the expensive candidate', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const big = buildDescriptor({
      id: 'big',
      contextLength: 8000,
      pricing: tokenPricingFixture({ input: 50_000n, output: 50_000n }),
    });
    // A wallet that funds cheap's floor + classifier reserve, but nowhere near
    // big's far larger worst case: the affordable-subset gate admits [cheap].
    const reserve = classifierReserveOf(cheap, [{ id: 'cheap' }, { id: 'big' }]);
    const cheapFloor = BASE_1000;
    const built = buildSmartModelCandidates({
      descriptors: [cheap, big],
      balanceNanoUsd: reserve + cheapFloor,
      tier: 'paid',
      promptChars: 0,
      inputChars: 0,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: SMART_NOW_MS,
    });
    expect(built?.candidates.map((candidate) => candidate.id)).toEqual(['cheap']);

    const estimateRun = createEstimateRun(resolverOf(cheap, big));
    const subsetCeiling = estimateRun(
      workflow([smartModelNode('s1', built!.classifierModelId, ['cheap'])])
    );
    // One affordable candidate, model dimension only → the classifier
    // short-circuits (no reserve); admission holds the CHEAP ceiling alone.
    expect(subsetCeiling._unsafeUnwrap()).toBe(cheapFloor);

    // Had the pre-legacy fixed menu handed admission the whole pool, the node
    // would have MAXed over big's worst case — strictly more than the subset.
    const fullPoolCeiling = estimateRun(
      workflow([smartModelNode('s1', 'cheap', ['cheap', 'big'])])
    );
    expect(fullPoolCeiling._unsafeUnwrap()).toBeGreaterThan(cheapFloor);
  });

  describe('the run estimator (eligible-subset reserve) never exceeds the client threshold', () => {
    // The client prices the affordability threshold
    // (`smartModelMinimumNanoUsd`) and the server pre-gate
    // (`buildSmartModelCandidates`) both over the FULL priceable pool; the run
    // estimator re-prices the classifier reserve over `node.candidates` — the
    // ELIGIBLE subset, the classifier's real runtime menu — which is a subset,
    // so its hold is only ever ≤ the reserve the client budgeted for. These pin
    // the exact biconditional END TO END through the real estimator, even when
    // the full pool's cheapest (the classifier) is itself ineligible and thus
    // absent from the eligible subset the estimator prices.
    const TINY = buildDescriptor({
      id: 'tiny',
      contextLength: 500, // < prompt(134) + MINIMUM_OUTPUT_TOKENS(1000) ⇒ ineligible
      pricing: tokenPricingFixture({ input: 1n, output: 2n }),
    });
    const WIDE_CHEAP = buildDescriptor({
      id: 'wide-cheap',
      contextLength: 8000,
      pricing: tokenPricingFixture({ input: 5n, output: 10n }),
    });
    const WIDE_PRICEY = buildDescriptor({
      id: 'wide-pricey',
      contextLength: 8000,
      pricing: tokenPricingFixture({ input: 6n, output: 12n }),
    });
    const DESCRIPTORS = [TINY, WIDE_CHEAP, WIDE_PRICEY];
    const TIER: UserTier = 'paid';
    const PROMPT_CHARS = 400;
    const PROMPT_TOKENS = inputTokensOf(PROMPT_CHARS);
    // The threshold comes from the shipped producer the payer freeze and the
    // client both call, not from a projection rebuilt here: a second projection
    // could range over a different pool than the builder below and the parity
    // this describe asserts would be measured against the wrong set.
    const CLIENT_THRESHOLD = smartModelMinimumNanoUsd({
      descriptors: DESCRIPTORS,
      pinned: [],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;

    function estimatorHold(balanceNanoUsd: bigint): bigint {
      const built = buildSmartModelCandidates({
        descriptors: DESCRIPTORS,
        balanceNanoUsd,
        tier: TIER,
        promptChars: PROMPT_CHARS,
        inputChars: PROMPT_CHARS,
        pinnedModelIds: [],
        webSearch: false,
        nowMs: SMART_NOW_MS,
      })!;
      const node = {
        id: 's1',
        version: 1,
        out: 'out',
        type: 'smartModel',
        classifierModelId: built.classifierModelId,
        candidates: built.candidates,
        promptInputTokens: PROMPT_TOKENS,
        params: {},
        in: { node: 'input', port: 'prompt' },
      };
      return createEstimateRun(resolverOf(...DESCRIPTORS))(
        workflow([node], { inputChars: PROMPT_CHARS })
      )._unsafeUnwrap();
    }

    it('refuses one nano below the client threshold and admits at it (client-deny ⇒ server-deny)', () => {
      expect(
        buildSmartModelCandidates({
          descriptors: DESCRIPTORS,
          balanceNanoUsd: CLIENT_THRESHOLD - 1n,
          tier: TIER,
          promptChars: PROMPT_CHARS,
          inputChars: PROMPT_CHARS,
          pinnedModelIds: [],
          webSearch: false,
          nowMs: SMART_NOW_MS,
        })
      ).toBeNull();
      expect(
        buildSmartModelCandidates({
          descriptors: DESCRIPTORS,
          balanceNanoUsd: CLIENT_THRESHOLD,
          tier: TIER,
          promptChars: PROMPT_CHARS,
          inputChars: PROMPT_CHARS,
          pinnedModelIds: [],
          webSearch: false,
          nowMs: SMART_NOW_MS,
        })
      ).not.toBeNull();
    });

    it('keeps the ineligible cheapest as the classifier but out of the eligible candidate set', () => {
      const built = buildSmartModelCandidates({
        descriptors: DESCRIPTORS,
        balanceNanoUsd: CLIENT_THRESHOLD * 100n,
        tier: TIER,
        promptChars: PROMPT_CHARS,
        inputChars: PROMPT_CHARS,
        pinnedModelIds: [],
        webSearch: false,
        nowMs: SMART_NOW_MS,
      })!;
      expect(built.classifierModelId).toBe('tiny');
      expect(built.candidates.map((candidate) => candidate.id)).not.toContain('tiny');
      // At a well-funded balance both wide models qualify, so the estimator prices
      // the classifier reserve over a two-candidate subset that still excludes the
      // classifier itself — a strict subset of the full pool the threshold priced.
      expect(built.candidates.map((candidate) => candidate.id)).toEqual([
        'wide-cheap',
        'wide-pricey',
      ]);
    });

    it('holds ≤ the admitted balance at the boundary and when well funded (no unpredicted 402)', () => {
      expect(estimatorHold(CLIENT_THRESHOLD)).toBeLessThanOrEqual(CLIENT_THRESHOLD);
      const funded = CLIENT_THRESHOLD * 100n;
      expect(estimatorHold(funded)).toBeLessThanOrEqual(funded);
    });
  });

  /**
   * A pinned model on auto effort still buys a classifier, but the MODEL
   * dimension is closed — one candidate, nothing to route — so the prompt names
   * no model and the reserve prices no model line. Pricing one here while the
   * shared producer prices none would put the server BELOW the client, which is
   * the affordable-then-402 direction; both figures stay upper bounds on the
   * call the executor sends, but the gap has to point the other way.
   */
  it('holds the classifier reserve, and no model line, for a pinned + auto node', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
      ])
    );

    const classifierReserve = classifierReserveOf(cheap, []);
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000);
    // And it is genuinely smaller than the model-listing reserve, so the
    // assertion above cannot pass by the two being the same number.
    expect(classifierReserve).toBeLessThan(classifierReserveOf(cheap, [{ id: 'cheap' }]));
  });

  it('caps smartModel candidate (answer) ceilings via node params, classifier at its bounded reserve', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(
      resolverOf(cheap, buildDescriptor({ id: 'big', contextLength: 4000 }))
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap', 'big'], { params: { maxOutputTokens: 100 } }),
      ])
    );

    // The answer runs with the node's params, so each candidate's output leg is
    // capped at 100: cheap = 1000×3125 + 100×12_500 = 4_375_000; big = 4000×3125
    // + 100×12_500 = 13_750_000 → max candidate 13_750_000. The classifier call
    // never receives the answer params — it stays at its bounded reserve.
    const classifierReserve = classifierReserveOf(cheap, [{ id: 'cheap' }, { id: 'big' }]);
    expect(result._unsafeUnwrap()).toBe(classifierReserve + 13_750_000n);
  });

  it('multiplies a smartModel node (classifier reserve and candidate) by its enclosing fanOut width', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // Effort dimension declared so the single-candidate node still runs a
    // classifier (the model-only single candidate holds no reserve at all).
    const result = estimateRun(
      workflow([
        fanOutNode('f1', 's1', 3),
        smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
      ])
    );

    // Both the classifier reserve and the candidate ceiling scale by the width.
    // Effort-only, so the prompt names no model and the reserve prices none.
    const classifierReserve = classifierReserveOf(cheap, []) * 3n;
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 3n);
  });

  it('refuses gracefully when a nested enclosure multiplier exceeds the safe-integer range (classifier reserve)', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // workflow.ts bounds each container's maxWidth/maxIterations at .int().min(1)
    // with no upper bound, so nested same-axis loops can accumulate an enclosure
    // product past Number.MAX_SAFE_INTEGER while every individual bound stays
    // schema-valid: 1e8 × 1e8 = 1e16 > MAX_SAFE_INTEGER. The classifier reserve
    // scales by that product, and past the safe range the double no longer holds
    // the declared number — so admission must refuse it on the Result channel,
    // never hold against a multiplier nothing declared. The refusal comes from
    // the shared core's one ceiling guard, reached through the sibling candidate
    // leg, which is why the message is asserted and not only the code.
    const definition = workflow([
      loopNode('outer', 'inner', 100_000_000),
      loopNode('inner', 's1', 100_000_000),
      smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
    ]);

    const result = estimateRun(definition);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: 'validation',
      message: 'Estimate ceiling maxIterations must be a positive integer',
    });
  });

  it('refuses gracefully when the enclosure multiplier overflows to Infinity', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // Deep enough nesting overflows the enclosure product past Number.MAX_VALUE
    // to Infinity, which is a different failure from a merely unsafe integer:
    // BigInt(Infinity) THROWS. An exception on the admission path is a defect
    // (500 + Sentry) where every other over-range enclosure is a refusal, so
    // this must reach the same Result channel as the finite-but-unsafe case.
    const depth = 40;
    const loops = Array.from({ length: depth }, (_unused, index) =>
      loopNode(
        `loop-${String(index)}`,
        index === depth - 1 ? 's1' : `loop-${String(index + 1)}`,
        100_000_000
      )
    );
    const definition = workflow([
      ...loops,
      smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
    ]);

    const result = estimateRun(definition);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: 'validation',
      message: 'Estimate ceiling maxIterations must be a positive integer',
    });
  });

  it('fails closed when the smartModel classifier is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'mid', contextLength: 2000 }))
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'ghost', ['mid'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a smartModel candidate is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'cheap', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'ghost'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices the classifier without requiring its own context limit (truncated-context reserve)', () => {
    // The classifier reserve truncates input at MAX_CLASSIFIER_CONTEXT_CHARS and
    // caps output at CLASSIFIER_OUTPUT_TOKEN_CAP, so the classifier model needs a
    // per-token rate but NOT a context-window limit of its own.
    const cheap = buildDescriptor({ id: 'cheap' });
    const estimateRun = createEstimateRun(
      resolverOf(cheap, buildDescriptor({ id: 'mid', contextLength: 2000 }))
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['mid'], { classify: { model: false, effort: true } }),
      ])
    );

    const classifierReserve = classifierReserveOf(cheap, []);
    // mid contextLength 2000 priced on both legs = 2000×3125 + 2000×12_500.
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 2n);
  });

  it('fails closed when the smartModel classifier lacks a per-token rate', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({
          id: 'cheap',
          contextLength: 1000,
          pricing: perImagePricingFixture({ anchor: 1n, dearest: 1n }),
        }),
        buildDescriptor({ id: 'mid', contextLength: 2000 })
      )
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['mid'], { classify: { model: false, effort: true } }),
      ])
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  // The load-bearing money invariant: a free-tier default (Smart Model) turn's
  // worst-case admission ceiling must fit the daily allowance, or the free tier
  // cannot send at all. Before the corrected formula this priced full context on
  // every leg (~$4–$25); the stamped prompt basis + bounded answer cap + bounded
  // classifier reserve bring it under $0.05.
  it('holds the free-tier Smart worst-case admission ceiling within the daily allowance', () => {
    const cheap = buildDescriptor({
      id: 'cheap',
      contextLength: 200_000,
      pricing: tokenPricingFixture({ input: 100n, output: 100n }),
    });
    const sonnet = buildDescriptor({
      id: 'sonnet',
      contextLength: 200_000,
      pricing: tokenPricingFixture({ input: 3000n, output: 15_000n }),
    });
    const estimateRun = createEstimateRun(resolverOf(cheap, sonnet));

    // A stamped free-tier Smart turn: a real (small) prompt and a bounded answer.
    const bounded = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap', 'sonnet'], {
          promptInputTokens: 500,
          params: { maxOutputTokens: 1000 },
        }),
      ])
    );
    // The identical turn WITHOUT the stamped basis prices full context on every
    // leg — the regression this task fixes.
    const fullContext = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'sonnet'])]));

    expect(bounded._unsafeUnwrap() <= DAILY_ALLOWANCE_NANO_USD).toBe(true);
    // The unstamped ceiling is orders of magnitude over the allowance (the bug).
    expect(fullContext._unsafeUnwrap() > DAILY_ALLOWANCE_NANO_USD * 50n).toBe(true);
  });

  it('fails closed on a subWorkflow node whose nested cost cannot be priced here', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([subWorkflowNode('s1', 'nested')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a model is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'ghost')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a resolved text model has no token price', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({
          id: 'gpt',
          contextLength: 1000,
          pricing: perImagePricingFixture({ anchor: 40n, dearest: 40n }),
        })
      )
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a resolved model declares no context-token limit', () => {
    const estimateRun = createEstimateRun(resolverOf(buildDescriptor({ id: 'gpt' })));

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

/** One tool-carrying node, as the tool-loop oracle reads it. */
interface ToolLoopShape {
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly promptTokens: bigint;
  readonly outputCeiling: bigint;
  readonly steps: number;
  readonly inputChars: number;
}

/** A stamp storing no new message, so a node's own terms stand alone. */
const NO_NEW_INPUT = { inputChars: 0 } as const;

/** The storage one output token reserves: 5 stored characters at 300 nano. */
const OUTPUT_STORAGE_NANO_PER_TOKEN = 1500n;

/**
 * The `gpt` fixture as a tool loop: its full 1,000-token context on both legs,
 * at the ceiling of its stored 2,500 / 10,000.
 */
function gptLoop(steps: number): ToolLoopShape {
  return {
    inputRate: 3125n,
    outputRate: 12_500n,
    promptTokens: 1000n,
    outputCeiling: 1000n,
    steps,
    inputChars: 0,
  };
}

/**
 * The hold for one tool-carrying node, from first principles: every step
 * re-sends the prompt, every step emits up to the ceiling (each output token
 * reserving its stored characters), step k re-sends the output of every earlier step, each of the
 * `steps − 1` calls' results is re-sent on up to `steps − 1` later steps, each
 * of the `steps − 1` tool-carrying steps sends the tool-use overhead, each call
 * pays the tool's after-fee rate, and the stored search rows, the framing and
 * the prompt's own characters rest once.
 */
function toolLoopOracle(shape: ToolLoopShape): bigint {
  const steps = BigInt(shape.steps);
  const calls = steps - 1n;
  const resultTokens = BigInt(inputTokensOf(WEB_SEARCH_RESULT_MAX_CHARS));
  const promptEveryStep = steps * shape.promptTokens * shape.inputRate;
  const outputEveryStep =
    steps * shape.outputCeiling * (shape.outputRate + OUTPUT_STORAGE_NANO_PER_TOKEN);
  const ownOutputResent = ((steps * (steps - 1n)) / 2n) * shape.outputCeiling * shape.inputRate;
  const resultsResent = calls * (steps - 1n) * resultTokens * shape.inputRate;
  const overheadTokens = BigInt(toolLoopBound(['webSearch'], 1).overheadTokens);
  const toolUseOverhead = (steps - 1n) * overheadTokens * shape.inputRate;
  const toolFees = calls * toolCallBillableNano('webSearch');
  const restingChars = BigInt(
    WEB_SEARCH_ROW_MAX_CHARS + ASSISTANT_FRAMING_MAX_CHARS + shape.inputChars
  );
  return (
    promptEveryStep +
    outputEveryStep +
    ownOutputResent +
    resultsResent +
    toolUseOverhead +
    toolFees +
    restingChars * STORAGE_COST_PER_CHARACTER_NANO
  );
}

/** The same node carrying no tool: one call, its framing and the prompt's characters. */
function plainCallOracle(shape: ToolLoopShape): bigint {
  return (
    shape.promptTokens * shape.inputRate +
    shape.outputCeiling * (shape.outputRate + OUTPUT_STORAGE_NANO_PER_TOKEN) +
    BigInt(ASSISTANT_FRAMING_MAX_CHARS + shape.inputChars) * STORAGE_COST_PER_CHARACTER_NANO
  );
}

describe('estimateRun — the tool loop', () => {
  /** One catalog row's stored billable rates, fee already baked at ingestion. */
  const LOOP_PRICING: ModelDescriptor['pricing'] = tokenPricingFixture({
    input: 3450n,
    output: 17_250n,
  });

  function loopResolver(): ModelPricingResolver {
    return resolverOf(
      buildDescriptor({
        id: 'loop',
        contextLength: 1_000_000,
        maxOutputTokens: 128_000,
        pricing: LOOP_PRICING,
      })
    );
  }

  it("a searching node holds the tool loop's true maximum", () => {
    const estimateRun = createEstimateRun(loopResolver());
    const inputChars = 1234;

    const hold = estimateRun(
      workflow(
        [
          modelNode('m1', 'loop', {
            tools: ['webSearch'],
            maxSteps: 11,
            promptInputTokens: 10_000,
            params: { maxOutputTokens: 4000 },
          }),
        ],
        { inputChars }
      )
    )._unsafeUnwrap();

    // At the ceiling of the stored 3,450 / 17,250.
    expect(hold).toBe(
      toolLoopOracle({
        inputRate: 4313n,
        outputRate: 21_563n,
        promptTokens: 10_000n,
        outputCeiling: 4000n,
        steps: 11,
        inputChars,
      })
    );
  });

  it('holds the true maximum of a paid loop whose input rate exceeds its output rate', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({
          id: 'inverted',
          contextLength: 200_000,
          maxOutputTokens: 64_000,
          pricing: tokenPricingFixture({ input: 20_000n, output: 5000n }),
        })
      )
    );

    const hold = estimateRun(
      workflow(
        [
          modelNode('m1', 'inverted', {
            tools: ['webSearch'],
            maxSteps: 11,
            promptInputTokens: 3000,
            params: { maxOutputTokens: 1000 },
          }),
        ],
        { inputChars: 500 }
      )
    )._unsafeUnwrap();

    // At the ceiling of the stored 20,000 / 5,000.
    expect(hold).toBe(
      toolLoopOracle({
        inputRate: 25_000n,
        outputRate: 6250n,
        promptTokens: 3000n,
        outputCeiling: 1000n,
        steps: 11,
        inputChars: 500,
      })
    );
  });

  /**
   * One tool-carrying node shape: its rates, a context window with a provider
   * cap and a declared output ceiling inside it, a stamped prompt inside the
   * window, the new message, and a step count from the smallest
   * loop that can call a tool to the largest any turn may declare. The declared
   * ceiling never exceeds the cap, so it is the ceiling every step runs at.
   */
  const toolLoopNodeShapes = fc
    .record({
      inputRate: fc.bigInt({ min: 1n, max: 10n ** 6n }),
      outputRate: fc.bigInt({ min: 1n, max: 10n ** 6n }),
      contextLength: fc.integer({ min: 1, max: 2_000_000 }),
      capShare: fc.double({ min: 0, max: 1, noNaN: true }),
      ceilingShare: fc.double({ min: 0, max: 1, noNaN: true }),
      promptShare: fc.double({ min: 0, max: 1, noNaN: true }),
      inputChars: fc.nat({ max: 1_000_000 }),
      steps: fc.integer({ min: 2, max: 11 }),
    })
    .map((shape) => {
      const providerCap = Math.max(1, Math.floor(shape.contextLength * shape.capShare));
      const outputCeiling = Math.max(1, Math.floor(providerCap * shape.ceilingShare));
      const promptTokens = Math.floor(shape.contextLength * shape.promptShare);
      return { ...shape, providerCap, outputCeiling, promptTokens };
    });

  it('holds exactly the tool loop oracle for every node shape', () => {
    fc.assert(
      fc.property(toolLoopNodeShapes, (shape) => {
        const pricing = tokenPricingFixture({ input: shape.inputRate, output: shape.outputRate });
        const estimateRun = createEstimateRun(
          resolverOf(
            buildDescriptor({
              id: 'shape',
              contextLength: shape.contextLength,
              maxOutputTokens: shape.providerCap,
              pricing,
            })
          )
        );
        const hold = estimateRun(
          workflow(
            [
              modelNode('m1', 'shape', {
                tools: ['webSearch'],
                maxSteps: shape.steps,
                promptInputTokens: shape.promptTokens,
                params: { maxOutputTokens: shape.outputCeiling },
              }),
            ],
            { inputChars: shape.inputChars }
          )
        )._unsafeUnwrap();
        const held = ceilingOf(pricing.anchor).base;
        expect(hold).toBe(
          toolLoopOracle({
            inputRate: held.input,
            outputRate: held.output,
            promptTokens: BigInt(shape.promptTokens),
            outputCeiling: BigInt(shape.outputCeiling),
            steps: shape.steps,
            inputChars: shape.inputChars,
          })
        );
      })
    );
  });

  it('holds the tool loop of an unstamped tool-carrying node at provider cost alone', () => {
    const estimateRun = createEstimateRun(loopResolver());

    const hold = estimateRun(
      workflow([
        modelNode('m1', 'loop', {
          tools: ['webSearch'],
          maxSteps: 11,
          promptInputTokens: 10_000,
          params: { maxOutputTokens: 4000 },
        }),
      ])
    )._unsafeUnwrap();

    // 11 steps and 10 calls at the ceiling of 3,450 / 17,250, with no storage
    // term because nothing is stamped: prompt 11 × 10,000 × 4,313 = 474,430,000;
    // output 11 × 4,000 × 21,563 = 948,772,000; own output re-sent
    // 55 × 4,000 × 4,313 = 948,860,000; results re-sent 10 × 10 × 2,000 × 4,313
    // = 862,600,000; fees 10 × 5,750,000 = 57,500,000; and the tool-use overhead
    // on the 10 tool-carrying steps.
    const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
    expect(hold).toBe(3_292_162_000n + 10n * overheadTokens * 4313n);
  });

  it('refuses a tool-carrying node that declares more steps than the largest loop', () => {
    const estimateRun = createEstimateRun(loopResolver());

    const result = estimateRun(
      workflow([modelNode('m1', 'loop', { tools: ['webSearch'], maxSteps: 12 })], NO_NEW_INPUT)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a tool-carrying node whose one step leaves no tool call', () => {
    const estimateRun = createEstimateRun(loopResolver());

    const result = estimateRun(
      workflow([modelNode('m1', 'loop', { tools: ['webSearch'], maxSteps: 1 })], NO_NEW_INPUT)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a tool name no tool declares', () => {
    const estimateRun = createEstimateRun(loopResolver());

    const result = estimateRun(
      workflow([modelNode('m1', 'loop', { tools: ['codeRunner'], maxSteps: 11 })], NO_NEW_INPUT)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

/** The steps a node declares at one effort rung: that rung's calls and a final answering step. */
function stepsAt(effort: 'off' | 'low' | 'medium' | 'high' | 'max'): number {
  return toolLoopStepsFor(toolCallCapFor(effort));
}

/** The larger of two nano-USD amounts. */
function dearer(first: bigint, second: bigint): bigint {
  if (first > second) return first;
  return second;
}

describe('estimateRun at per-rung ceilings', () => {
  const LOOP_PRICING: ModelDescriptor['pricing'] = tokenPricingFixture({
    input: 3450n,
    output: 17_250n,
  });
  const CANDIDATE_PRICING: ModelDescriptor['pricing'] = tokenPricingFixture({
    input: 52n,
    output: 161n,
  });

  function perRungResolver(): ModelPricingResolver {
    return resolverOf(
      buildDescriptor({
        id: 'loop',
        contextLength: 1_000_000,
        maxOutputTokens: 128_000,
        pricing: LOOP_PRICING,
      }),
      buildDescriptor({
        id: 'other',
        contextLength: 1_000_000,
        maxOutputTokens: 128_000,
        pricing: tokenPricingFixture({ input: 600n, output: 2400n }),
      }),
      buildDescriptor({
        id: 'cand-a',
        contextLength: 131_072,
        maxOutputTokens: 16_384,
        pricing: CANDIDATE_PRICING,
      }),
      buildDescriptor({
        id: 'cand-b',
        contextLength: 131_072,
        maxOutputTokens: 16_384,
        pricing: CANDIDATE_PRICING,
      })
    );
  }

  /** A searching node declaring its steps at High, with a ceiling at each rung. */
  function perRungNode(
    id: string,
    model: string,
    rungCeilings: Readonly<Record<string, number>>
  ): unknown {
    return modelNode(id, model, {
      tools: ['webSearch'],
      maxSteps: stepsAt('high'),
      promptInputTokens: 10_000,
      params: { maxOutputTokens: rungCeilings['high'] },
      rungCeilings,
    });
  }

  function loopAt(
    rates: { readonly input: bigint; readonly output: bigint },
    effort: 'off' | 'low' | 'high',
    ceiling: number
  ): bigint {
    return toolLoopOracle({
      inputRate: rates.input,
      outputRate: rates.output,
      promptTokens: 10_000n,
      outputCeiling: BigInt(ceiling),
      steps: stepsAt(effort),
      inputChars: 0,
    });
  }

  /** A Smart Model candidate's one plain answer at a cap, at the ceiling of the candidates' 52 / 161. */
  function candidateAnswer(ceiling: number): bigint {
    return plainCallOracle({
      inputRate: 65n,
      outputRate: 202n,
      promptTokens: 10_000n,
      outputCeiling: BigInt(ceiling),
      steps: 1,
      inputChars: 0,
    });
  }

  /** The ceilings of the stored 3,450 / 17,250 and 600 / 2,400. */
  const LOOP_RATES = { input: 4313n, output: 21_563n } as const;
  const OTHER_RATES = { input: 750n, output: 3000n } as const;

  it("prices a node at its dearest rung's loop and ceiling", () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const ceilings = { off: 90_000, low: 40_000, high: 12_000 } as const;

    const hold = estimateRun(
      workflow([perRungNode('m1', 'loop', ceilings)], NO_NEW_INPUT)
    )._unsafeUnwrap();

    const byRung = (['off', 'low', 'high'] as const).map((effort) =>
      loopAt(LOOP_RATES, effort, ceilings[effort])
    );
    let dearest = 0n;
    for (const amount of byRung) if (amount > dearest) dearest = amount;
    expect(hold).toBe(dearest);
  });

  it('prices every per-rung node at one rung at a time, since one decision serves the turn', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    // Each node is dearest at a different rung, so summing each node's own
    // dearest rung would hold for a turn no single decision can produce.
    const first = { off: 100_000, high: 1000 } as const;
    const second = { off: 1000, high: 60_000 } as const;

    const hold = estimateRun(
      workflow([perRungNode('m1', 'loop', first), perRungNode('m2', 'other', second)], NO_NEW_INPUT)
    )._unsafeUnwrap();

    const atOff = loopAt(LOOP_RATES, 'off', first.off) + loopAt(OTHER_RATES, 'off', second.off);
    const atHigh =
      loopAt(LOOP_RATES, 'high', first.high) + loopAt(OTHER_RATES, 'high', second.high);
    expect(hold).toBe(dearer(atOff, atHigh));
    const eachAtItsOwnDearest =
      loopAt(LOOP_RATES, 'off', first.off) + loopAt(OTHER_RATES, 'high', second.high);
    expect(hold).toBeLessThan(eachAtItsOwnDearest);
  });

  it("prices a Smart Model candidate at its cap for the rung its siblings' loops run at", () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const sibling = { off: 50_000, high: 8000 } as const;
    const slot = smartModelNode('slot', 'cand-a', [], {
      inputSchema: 'turnDecision',
      promptInputTokens: 10_000,
      candidates: [
        { id: 'cand-a', maxOutputTokens: 16_000, rungCeilings: { off: 16_000, high: 4000 } },
        { id: 'cand-b', maxOutputTokens: 9000, rungCeilings: { off: 9000 } },
      ],
    });

    const hold = estimateRun(
      workflow([perRungNode('m1', 'loop', sibling), slot], NO_NEW_INPUT)
    )._unsafeUnwrap();

    // At High only the first candidate can answer, at its High cap.
    const atOff = loopAt(LOOP_RATES, 'off', sibling.off) + candidateAnswer(16_000);
    const atHigh = loopAt(LOOP_RATES, 'high', sibling.high) + candidateAnswer(4000);
    expect(hold).toBe(dearer(atOff, atHigh));
  });

  it('prices a Smart Model candidate with no per-rung caps at its own cap at every rung', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const sibling = { off: 50_000, high: 8000 } as const;
    const slot = smartModelNode('slot', 'cand-a', [], {
      inputSchema: 'turnDecision',
      promptInputTokens: 10_000,
      candidates: [
        { id: 'cand-a', maxOutputTokens: 4000, rungCeilings: { off: 4000, high: 3000 } },
        { id: 'cand-b', maxOutputTokens: 12_000 },
      ],
    });

    const hold = estimateRun(
      workflow([perRungNode('m1', 'loop', sibling), slot], NO_NEW_INPUT)
    )._unsafeUnwrap();

    const answer = plainCallOracle({
      inputRate: 65n,
      outputRate: 202n,
      promptTokens: 10_000n,
      outputCeiling: 12_000n,
      steps: 1,
      inputChars: 0,
    });
    const atOff = loopAt(LOOP_RATES, 'off', sibling.off) + answer;
    const atHigh = loopAt(LOOP_RATES, 'high', sibling.high) + answer;
    expect(hold).toBe(dearer(atOff, atHigh));
  });

  it('refuses a rung whose loop takes more steps than the node declares', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const node = modelNode('m1', 'loop', {
      tools: ['webSearch'],
      maxSteps: stepsAt('low'),
      promptInputTokens: 10_000,
      params: { maxOutputTokens: 4000 },
      rungCeilings: { low: 4000, high: 2000 },
    });

    const result = estimateRun(workflow([node], NO_NEW_INPUT));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses per-rung ceilings on a node that carries no tool', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const node = modelNode('m1', 'loop', {
      promptInputTokens: 10_000,
      params: { maxOutputTokens: 4000 },
      rungCeilings: { off: 4000 },
    });

    const result = estimateRun(workflow([node], NO_NEW_INPUT));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices a node with no entry at a rung at its declared pair there', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    // The second node names no High entry, so at High it runs what it declares:
    // High's steps and a 4,000-token cap. The first node's High entry sits above
    // its own declared cap, so High is dearer than the point where both run what
    // they declare, and the second node's share of High shows in the hold.
    const first = modelNode('m1', 'loop', {
      tools: ['webSearch'],
      maxSteps: stepsAt('high'),
      promptInputTokens: 10_000,
      params: { maxOutputTokens: 4000 },
      rungCeilings: { off: 9000, high: 20_000 },
    });
    const second = modelNode('m2', 'other', {
      tools: ['webSearch'],
      maxSteps: stepsAt('high'),
      promptInputTokens: 10_000,
      params: { maxOutputTokens: 4000 },
      rungCeilings: { off: 9000 },
    });

    const hold = estimateRun(workflow([first, second], NO_NEW_INPUT))._unsafeUnwrap();

    const atOff = loopAt(LOOP_RATES, 'off', 9000) + loopAt(OTHER_RATES, 'off', 9000);
    const atHigh = loopAt(LOOP_RATES, 'high', 20_000) + loopAt(OTHER_RATES, 'high', 4000);
    expect(atHigh).toBeGreaterThan(atOff);
    expect(hold).toBe(atHigh);
  });

  it('prices a node at its declared pair when that pair costs more than every entry', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const node = modelNode('m1', 'loop', {
      tools: ['webSearch'],
      maxSteps: stepsAt('high'),
      promptInputTokens: 10_000,
      params: { maxOutputTokens: 50_000 },
      rungCeilings: { off: 1000 },
    });

    const hold = estimateRun(workflow([node], NO_NEW_INPUT))._unsafeUnwrap();

    expect(hold).toBe(loopAt(LOOP_RATES, 'high', 50_000));
    expect(hold).toBeGreaterThan(loopAt(LOOP_RATES, 'off', 1000));
  });

  it('leaves a candidate with no entry at a rung out of that rung`s figure', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    // High is the dearer rung, so a candidate wrongly priced there would show.
    const sibling = { off: 1000, high: 20_000 } as const;
    // The dearer candidate carries a cap for Off only, so at High it cannot run and
    // its declared cap is no pricing point while it carries a record.
    const slot = smartModelNode('slot', 'cand-a', [], {
      inputSchema: 'turnDecision',
      promptInputTokens: 10_000,
      candidates: [
        { id: 'cand-a', maxOutputTokens: 16_000, rungCeilings: { off: 16_000 } },
        { id: 'cand-b', maxOutputTokens: 3000, rungCeilings: { off: 3000, high: 3000 } },
      ],
    });

    const hold = estimateRun(
      workflow([perRungNode('m1', 'loop', sibling), slot], NO_NEW_INPUT)
    )._unsafeUnwrap();

    const atOff = loopAt(LOOP_RATES, 'off', sibling.off) + candidateAnswer(16_000);
    const atHigh = loopAt(LOOP_RATES, 'high', sibling.high) + candidateAnswer(3000);
    expect(atHigh).toBeGreaterThan(atOff);
    expect(hold).toBe(atHigh);
  });

  it('refuses a rung no Smart Model candidate can answer at', () => {
    const estimateRun = createEstimateRun(perRungResolver());
    const slot = smartModelNode('slot', 'cand-a', [], {
      inputSchema: 'turnDecision',
      promptInputTokens: 10_000,
      candidates: [{ id: 'cand-a', maxOutputTokens: 9000, rungCeilings: { off: 9000 } }],
    });

    const result = estimateRun(
      workflow([perRungNode('m1', 'loop', { off: 9000, high: 4000 }), slot], NO_NEW_INPUT)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

/**
 * Media (image/video) nodes price deterministically from catalog rates and
 * the node's declared call params — no context window exists to bound them.
 */
function mediaDescriptor(params: {
  readonly id: string;
  readonly outputs: readonly ('image' | 'video')[];
  readonly pricing: ModelDescriptor['pricing'];
}): ModelDescriptor {
  return {
    ...buildDescriptor({ id: params.id, pricing: params.pricing }),
    inputs: ['text'],
    outputs: [...params.outputs],
    behaviors: [],
  };
}

describe('estimateRun — deterministic media ceilings', () => {
  const IMAGE_PRICING: ModelDescriptor['pricing'] = perImagePricingFixture({
    anchor: 40_000_000n,
    dearest: 40_000_000n,
  });
  const VIDEO_PRICING: ModelDescriptor['pricing'] = perSecondPricingFixture({
    anchor: { '720p': 98_800_000n },
    dearest: { '720p': 98_800_000n },
  });

  it('refuses a multi-image node at estimate time (one generation call, one artifact)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img', { params: { n: 2 } })]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices an image node with no params at one output image', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')]));

    expect(result._unsafeUnwrap()).toBe(40_000_000n);
  });

  it('prices a video node per second at the requested resolution', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '720p', durationSeconds: 4 } })])
    );

    expect(result._unsafeUnwrap()).toBe(395_200_000n);
  });

  it('multiplies a media node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(
      workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'img', { params: { n: 1 } })])
    );

    expect(result._unsafeUnwrap()).toBe(40_000_000n * 3n);
  });

  it('refuses a video node missing the params that make it priceable', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'vid')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a video node whose resolution is absent from the pricing matrix', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '4k', durationSeconds: 4 } })])
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses an image node whose price is not per image (fail-closed, never a silent zero)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: TOKEN_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('estimateMinMediaOutputBytes', () => {
  it('returns zero for a non-media (text) call', () => {
    expect(estimateMinMediaOutputBytes('language', {})).toBe(0);
    expect(estimateMinMediaOutputBytes(undefined, {})).toBe(0);
  });

  it('scales a video floor linearly with declared duration', () => {
    const short = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 4 });
    const long = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 });

    expect(long).toBe(short * 2);
  });

  it('scales a video floor with resolution area (720p < 1080p < 4k)', () => {
    const r720 = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 });
    const r1080 = estimateMinMediaOutputBytes('video', { resolution: '1080p', durationSeconds: 8 });
    const r4k = estimateMinMediaOutputBytes('video', { resolution: '4k', durationSeconds: 8 });

    expect(r1080).toBeGreaterThan(r720);
    expect(r4k).toBeGreaterThan(r1080);
    // 1080p / 720p area ratio is exactly 2.25 — structural, not tied to the floor.
    expect(r1080).toBe(Math.floor((r720 * (1920 * 1080)) / (1280 * 720)));
  });

  it('scales an image floor with megapixels', () => {
    const oneMp = estimateMinMediaOutputBytes('image', { resolution: '1000x1000' });
    const fourMp = estimateMinMediaOutputBytes('image', { resolution: '2000x2000' });

    expect(oneMp).toBeGreaterThan(0);
    expect(fourMp).toBe(oneMp * 4);
  });

  it('scales an image floor with the requested count n', () => {
    const one = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 1 });
    const two = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 2 });

    expect(two).toBe(one * 2);
  });

  it('treats a video with no declared duration as zero (nothing to gate)', () => {
    expect(estimateMinMediaOutputBytes('video', { resolution: '720p' })).toBe(0);
    expect(estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 0 })).toBe(
      0
    );
  });

  it('falls back to the baseline resolution factor when the tier is unrecognized', () => {
    const baseline = estimateMinMediaOutputBytes('video', {
      resolution: '720p',
      durationSeconds: 8,
    });
    const unknown = estimateMinMediaOutputBytes('video', {
      resolution: 'ultra-hd',
      durationSeconds: 8,
    });

    // Unknown tier → area unknown → baseline factor (never inflated), so the
    // floor matches the 720p baseline rather than false-rejecting.
    expect(unknown).toBe(baseline);
  });

  it('returns zero for an image with no parseable resolution', () => {
    expect(estimateMinMediaOutputBytes('image', {})).toBe(0);
    expect(estimateMinMediaOutputBytes('image', { resolution: 42 })).toBe(0);
  });

  it('treats a non-positive image count as one', () => {
    const single = estimateMinMediaOutputBytes('image', { resolution: '1000x1000' });
    const zeroCount = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 0 });

    expect(zeroCount).toBe(single);
  });

  it('never resolves a hostile resolution key to an inherited member', () => {
    // `'constructor'` on a plain-object map would resolve Object's constructor;
    // the Map-backed lookup yields undefined → treated as an unparseable string.
    expect(
      estimateMinMediaOutputBytes('video', { resolution: 'constructor', durationSeconds: 8 })
    ).toBe(estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 }));
  });

  it('sits just under the value-store budget at the video floor boundary, and just over one step higher', () => {
    // 4k, 74s is the largest declaration whose minimum-plausible bytes still fit
    // the 20 MB budget under the conservative floor; 75s is the first that cannot.
    const underBudget = estimateMinMediaOutputBytes('video', {
      resolution: '4k',
      durationSeconds: 74,
    });
    const overBudget = estimateMinMediaOutputBytes('video', {
      resolution: '4k',
      durationSeconds: 75,
    });

    expect(underBudget).toBeLessThanOrEqual(VALUE_STORE_BYTE_BUDGET_BYTES);
    expect(overBudget).toBeGreaterThan(VALUE_STORE_BYTE_BUDGET_BYTES);
  });
});

describe('estimateRun — media output size gate', () => {
  // Prices 4k so the ONLY thing that can reject an oversize 4k declaration is
  // the size gate, never a missing pricing rate.
  const VIDEO_PRICING_4K: ModelDescriptor['pricing'] = perSecondPricingFixture({
    anchor: { '4k': 98_800_000n },
    dearest: { '4k': 98_800_000n },
  });

  it('rejects a video whose minimum-plausible output cannot fit the value-store budget', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING_4K }))
    );

    const params = { resolution: '4k', durationSeconds: 75 };
    // The declaration is genuinely over budget and would otherwise price fine.
    expect(estimateMinMediaOutputBytes('video', params)).toBeGreaterThan(
      VALUE_STORE_BYTE_BUDGET_BYTES
    );

    const result = estimateRun(workflow([modelNode('m1', 'vid', { params })]));

    // Surfaced via the same VALIDATION fail-closed channel as any unpriceable
    // node; the interpreter turns this into `failBeforeAdmission` (before the
    // admission hook and before any provider call).
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('admits a normal-size video generation — same pricing, smaller declaration', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING_4K }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '4k', durationSeconds: 4 } })])
    );

    expect(result.isOk()).toBe(true);
  });

  it('leaves a text-only run unaffected by the media size gate', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });
});

/**
 * A persisting turn stamps `storage = { inputChars }` onto its DEFINITION, and
 * the ceiling then covers, PASS-THROUGH (never marked up): input storage ONCE at
 * the definition level (`inputChars × charRate`), output storage per
 * answer-producing node (`outputCeiling × 5 stored chars per token × charRate`),
 * and media output storage (`estimatedBytes × byteRate`); the classifier
 * reserve adds none, because its prompt and answer never rest. Every canonical (with-storage) figure below is
 * hand-derived from those formulas. A run WITHOUT a storage stamp is unchanged
 * (pinned by the suites above), so these assert the storage delta directly. The
 * estimator reads the stamp per-run from the definition it is handed — one
 * estimator instance, no per-caller storage argument.
 */
describe('estimateRun — persisting-turn storage', () => {
  const CHAR_RATE = STORAGE_COST_PER_CHARACTER_NANO; // 300 nano/char
  /** The framing allowance every persisting text answer reserves. */
  const FRAMING = BigInt(ASSISTANT_FRAMING_MAX_CHARS) * CHAR_RATE;
  const IMAGE_PRICING: ModelDescriptor['pricing'] = perImagePricingFixture({
    anchor: 40_000_000n,
    dearest: 40_000_000n,
  });
  const VIDEO_PRICING: ModelDescriptor['pricing'] = perSecondPricingFixture({
    anchor: { '720p': 98_800_000n },
    dearest: { '720p': 98_800_000n },
  });

  it('adds output storage per text node at 5 chars/token and input storage once', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')], { inputChars: 100 }));

    // provider = BASE_1000 = 15,625,000.
    // output-storage = outputCeiling(1000) × 5 stored chars × 300 = 1,500,000.
    // input-storage (once) = 100 × 300 = 30,000; framing = 640 × 300 = 192,000.
    // Storage never marks up.
    const outputStorage = 1000n * OUTPUT_STORAGE_NANO_PER_TOKEN;
    expect(result._unsafeUnwrap()).toBe(BASE_1000 + outputStorage + 100n * CHAR_RATE + FRAMING);
    expect(outputStorage).toBe(1_500_000n);
  });

  it('reserves NO output storage for a node whose output another node consumes', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );
    // Settlement persists SINK outputs, so a consumed value is never stored and
    // reserving storage for it holds money nothing can bill. The decision
    // reducer consuming `m1` is exactly that shape.
    const consumed = workflow(
      [
        modelNode('m1', 'gpt', { in: { node: 'input', port: 'prompt' } }),
        fanInNode('decide', TURN_DECISION_REDUCER, [
          { node: 'input', port: 'prompt' },
          { node: 'm1', port: 'out' },
        ]),
      ],
      { inputChars: 0 },
      [
        edge('input', 'prompt', 'm1', 'in'),
        edge('input', 'prompt', 'decide', 'in0'),
        edge('m1', 'out', 'decide', 'in1'),
      ]
    );

    expect(estimateRun(consumed)._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('reserves that same output storage once nothing reads the node', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );
    // The discriminator for the pin above: one edge moved off `m1`, everything
    // else identical, and the storage the pin asserts absent comes back.
    const unread = workflow(
      [
        modelNode('m1', 'gpt', { in: { node: 'input', port: 'prompt' } }),
        fanInNode('decide', TURN_DECISION_REDUCER, [
          { node: 'input', port: 'prompt' },
          { node: 'input', port: 'prompt' },
        ]),
      ],
      { inputChars: 0 },
      [
        edge('input', 'prompt', 'm1', 'in'),
        edge('input', 'prompt', 'decide', 'in0'),
        edge('input', 'prompt', 'decide', 'in1'),
      ]
    );
    const outputStorage = 1000n * OUTPUT_STORAGE_NANO_PER_TOKEN;

    expect(estimateRun(unread)._unsafeUnwrap()).toBe(BASE_1000 + outputStorage + FRAMING);
  });

  it('reserves no output storage for a producer only a branch reads', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );
    // A `branch` carries no embedded input ref — it reads its producer through
    // an edge alone — so a definition-side walk over node refs could not see
    // this consumption and would reserve storage for a value settlement never
    // persists. The reserve is exact here rather than generous, and exact still
    // covers the bill: the branch is not a sink either, so the whole graph
    // persists nothing and the storage term is zero on both sides.
    const branchFed = workflow(
      [
        modelNode('m1', 'gpt', { in: { node: 'input', port: 'prompt' } }),
        branchNode('route', { done: 'end' }, 'end'),
      ],
      { inputChars: 0 },
      [edge('input', 'prompt', 'm1', 'in'), edge('m1', 'out', 'route', 'in')]
    );

    expect(estimateRun(branchFed)._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('reserves no output storage for a producer only a loop reads', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );
    const loopFed = workflow(
      [
        modelNode('m1', 'gpt', { in: { node: 'input', port: 'prompt' } }),
        loopNode('l1', 'body', 2),
        modelNode('body', 'gpt', { in: { node: 'l1', port: 'state' } }),
      ],
      { inputChars: 0 },
      [
        edge('input', 'prompt', 'm1', 'in'),
        edge('m1', 'out', 'l1', 'in'),
        edge('l1', 'state', 'body', 'in'),
      ]
    );
    // Only `modelCall`/`smartModel` nodes carry an output-storage term, and the
    // reserve applies it to every unconsumed producer — `body` is the only
    // unconsumed node of that class, priced over the loop's iteration count.
    // The run never persists that value: a loop's body is child-driven, and the
    // sink predicate excludes child-driven nodes. The reserve is therefore
    // generous here, in the safe direction.
    const bodyStorage = 2n * (1000n * OUTPUT_STORAGE_NANO_PER_TOKEN + FRAMING);

    expect(estimateRun(loopFed)._unsafeUnwrap()).toBe(BASE_1000 + BASE_1000 * 2n + bodyStorage);
  });

  it('still reserves output storage for the sink the same graph persists', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );
    const sinkOnly = workflow([modelNode('m1', 'gpt')], { inputChars: 0 });
    const outputStorage = 1000n * OUTPUT_STORAGE_NANO_PER_TOKEN;

    expect(estimateRun(sinkOnly)._unsafeUnwrap()).toBe(BASE_1000 + outputStorage + FRAMING);
  });

  it('includes media output storage for an image node (ESTIMATED_IMAGE_BYTES × byte rate)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')], { inputChars: 0 }));

    // provider = 40,000,000 = 46,000,000.
    // media-storage = ESTIMATED_IMAGE_BYTES(8,000,000) × 18 = 144,000,000. No output tokens.
    const mediaStorage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(result._unsafeUnwrap()).toBe(40_000_000n + mediaStorage);
    expect(mediaStorage).toBe(144_000_000n);
  });

  it('includes media output storage for a video node (duration × per-second bytes × byte rate)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '720p', durationSeconds: 4 } })], {
        inputChars: 0,
      })
    );

    // provider = 98,800,000 × 4 = 395,200,000 = 454,480,000.
    // media-storage = 4 × ESTIMATED_VIDEO_BYTES_PER_SECOND(5,000,000) × 18 = 360,000,000.
    const mediaStorage =
      4n * BigInt(ESTIMATED_VIDEO_BYTES_PER_SECOND) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(result._unsafeUnwrap()).toBe(395_200_000n + mediaStorage);
    expect(mediaStorage).toBe(360_000_000n);
  });

  it('adds candidate-output and input storage to a smartModel node, never classifier storage', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const pinnedAuto = { classify: { model: false, effort: true } };
    const withStorageDefinition = workflow([smartModelNode('s1', 'cheap', ['cheap'], pinnedAuto)], {
      inputChars: 50,
    });
    const withoutStorageDefinition = workflow([
      smartModelNode('s1', 'cheap', ['cheap'], pinnedAuto),
    ]);

    // The one candidate ('cheap', full-context 1000 output) at 5 stored chars per token.
    const candidateOutputStorage = 1000n * OUTPUT_STORAGE_NANO_PER_TOKEN;
    const inputStorage = 50n * CHAR_RATE;
    // The classifier contributes NO storage to the difference: its prompt and
    // answer never rest, so the reserve has no storage leg to switch on when the
    // turn persists. What the classifier would have added is measured here so the
    // assertion cannot pass by the term being small.
    const reserveChars = classifierReserveChars([{ id: 'cheap' }]);
    const classifierStorageIfItExisted =
      BigInt(reserveChars) * CHAR_RATE +
      BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * OUTPUT_STORAGE_NANO_PER_TOKEN;
    expect(classifierStorageIfItExisted).toBeGreaterThan(0n);

    const delta =
      estimateRun(withStorageDefinition)._unsafeUnwrap() -
      estimateRun(withoutStorageDefinition)._unsafeUnwrap();
    expect(delta).toBe(candidateOutputStorage + inputStorage + FRAMING);
  });

  it('adds no storage when the definition carries no storage stamp', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // Provider cost only — the pre-storage default for general (non-persisting) runs.
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });
});

describe('mediaTurnMinCostNanoUsd — the payer freeze media minimum', () => {
  const IMAGE_PRICING: ModelDescriptor['pricing'] = perImagePricingFixture({
    anchor: 40_000_000n,
    dearest: 40_000_000n,
  });
  const VIDEO_PRICING: ModelDescriptor['pricing'] = perSecondPricingFixture({
    anchor: { '720p': 98_800_000n },
    dearest: { '720p': 98_800_000n },
  });
  const PROMPT_CHARS = 400;
  const STORAGE = { inputChars: PROMPT_CHARS };
  const IMAGE_BYTES_NANO = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
  const PROMPT_STORAGE_NANO = BigInt(PROMPT_CHARS) * STORAGE_COST_PER_CHARACTER_NANO;

  it('prices one image at its per-unit rate plus the bytes it will store', () => {
    const image = mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING });

    const result = mediaTurnMinCostNanoUsd([image], {}, STORAGE);

    expect(result._unsafeUnwrap()).toBe(40_000_000n + IMAGE_BYTES_NANO + PROMPT_STORAGE_NANO);
  });

  it('sums every sibling generation but counts the prompt storage once', () => {
    const first = mediaDescriptor({ id: 'img-a', outputs: ['image'], pricing: IMAGE_PRICING });
    const second = mediaDescriptor({ id: 'img-b', outputs: ['image'], pricing: IMAGE_PRICING });

    const result = mediaTurnMinCostNanoUsd([first, second], {}, STORAGE);

    // Every sibling answers, so the media leg is a Σ — a MAX would under-state a
    // fan-out and reopen the band the freeze exists to close.
    expect(result._unsafeUnwrap()).toBe(
      (40_000_000n + IMAGE_BYTES_NANO) * 2n + PROMPT_STORAGE_NANO
    );
  });

  it('prices a video at its requested duration and resolution', () => {
    const video = mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING });

    const result = mediaTurnMinCostNanoUsd(
      [video],
      { resolution: '720p', durationSeconds: 4 },
      STORAGE
    );

    const bytes = BigInt(4 * ESTIMATED_VIDEO_BYTES_PER_SECOND) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(result._unsafeUnwrap()).toBe(98_800_000n * 4n + bytes + PROMPT_STORAGE_NANO);
  });

  it('fails closed on a selection that generates no media, never a silent zero', () => {
    const text = buildDescriptor({ id: 'gpt', contextLength: 1000 });

    const result = mediaTurnMinCostNanoUsd([text], {}, STORAGE);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed on a media call whose units cannot be parsed', () => {
    const video = mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING });

    const result = mediaTurnMinCostNanoUsd([video], { resolution: '720p' }, STORAGE);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
