/**
 * Over every turn `answerRoomTurnArb` and `unpinnedTurnArb` draw, the server
 * compiles exactly the sends the browser's admissible pass admits. Funding is
 * far above every hold, so the only bound either side can refuse on is each
 * model's answer room: the provider cap and the context headroom the prompt
 * leaves.
 *
 * `answerRoomTurnArb` draws a turn of one to three models, at a pinned rung or
 * with none. The lead model offers the whole ladder, so every rung is in the
 * turn's option set; each sibling is a full-ladder reasoner, a two-rung reasoner
 * that falls to off below its Low rung, a model that does not reason, or a
 * mandatory-reasoning model (budget-native, or offering a single effort word).
 * The off sibling and the reasoning-free sibling reserve no reasoning budget,
 * and each is held to a minimum answer alone; a mandatory model is held to at
 * least its cheapest rung. `unpinnedTurnArb` draws one to three models that do
 * not reason or cannot stop reasoning, with no rung pinned. Classifying `auto`
 * turns and web search are outside both generators' reach.
 *
 * Every model's two room terms are drawn as offsets from the smallest room its
 * resolved rung fits, with -1, 0 and 1 drawn deliberately: a room one token
 * short of that floor and one exactly holding it are where a refusal and a send
 * part. The floor is found by searching the published fit, so the test reaches
 * no money-layer internal.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CANONICAL_REASONING_EFFORTS, modelId, nanoUSD } from '@hushbox/shared';
import {
  effortFitsAnswerRoom,
  getTurnOptions,
  priceableModelFrom,
  unpinnedEffortOf,
} from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  compileMultiModelTurnOutcome,
  compileSingleTurn,
  promptInputTokensFor,
} from './definition.js';
import { resolveTurnReasoning } from './reasoning.js';
import type { TurnBudget } from './definition.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type {
  CanonicalReasoningEffort,
  ModelDescriptor,
  ModelReasoning,
  ResolvedReasoningEffort,
} from '@hushbox/shared';

type PriceableModel = Parameters<typeof getTurnOptions>[3]['models'][number];

/** Far above any hold a drawn case can take, so money never binds. */
const SPENDABLE = 10n ** 13n;

const INPUT_RATE = 100n;
const OUTPUT_RATE = 300n;

/** Wide enough that the context never binds while a floor is searched. */
const SEARCH_CONTEXT = 10_000_000;

const SHAPES = {
  /** Budget-native: every rung, each a clamped token budget. */
  budgetNative: {},
  /** Every rung, each a native effort word. */
  nativeWords: { supportedEfforts: null },
  /** Low and High only, so Lite has no rung below it and resolves to off. */
  twoRung: { supportedEfforts: ['high', 'low'] },
  /** No reasoning metadata: the model does not reason. */
  plain: undefined,
  /** Budget-native, and reasoning cannot be turned off. */
  mandatoryBudgetNative: { mandatory: true },
  /** One native effort word, and reasoning cannot be turned off. */
  mandatorySingleWord: { supportedEfforts: ['high'], mandatory: true },
} as const satisfies Record<string, ModelReasoning | undefined>;

type Shape = keyof typeof SHAPES;

const FULL_LADDER_SHAPES: readonly Shape[] = [
  'budgetNative',
  'nativeWords',
  'mandatoryBudgetNative',
];
const SIBLING_SHAPES: readonly Shape[] = [
  'budgetNative',
  'nativeWords',
  'twoRung',
  'plain',
  'mandatoryBudgetNative',
  'mandatorySingleWord',
];
const UNPINNED_SHAPES: readonly Shape[] = ['plain', 'mandatoryBudgetNative', 'mandatorySingleWord'];

interface DrawnModel {
  readonly shape: Shape;
  readonly capOffset: number;
  readonly headroomOffset: number;
}

interface RoomedModel {
  readonly id: string;
  readonly shape: Shape;
  readonly providerCap: number;
  readonly contextLength: number;
}

interface AnswerRoomTurn {
  readonly effort: CanonicalReasoningEffort | undefined;
  readonly promptChars: number;
  readonly models: readonly [RoomedModel, ...RoomedModel[]];
}

function descriptorOf(model: RoomedModel): ModelDescriptor {
  const reasoning = SHAPES[model.shape];
  return {
    id: model.id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: model.contextLength, maxOutputTokens: model.providerCap },
    pricing: tokenPricingFixture({ input: INPUT_RATE, output: OUTPUT_RATE }),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function resolverOf(models: readonly RoomedModel[]): ModelPricingResolver {
  const catalog = models.map((model) => descriptorOf(model));
  return (id) => catalog.find((descriptor) => descriptor.id === id);
}

function priceableOf(model: RoomedModel): PriceableModel {
  const priceable = priceableModelFrom(descriptorOf(model));
  if (priceable === undefined) throw new Error(`drawn model '${model.id}' is not priceable`);
  return priceable;
}

function budgetOf(promptChars: number): TurnBudget {
  return {
    promptCharacterCount: promptChars,
    inputCharacterCount: 0,
    funding: { kind: 'purchased', spendableNanoUsd: SPENDABLE },
  };
}

const floorCache = new Map<string, number>();

/**
 * The smallest provider cap at which a model of `shape` fits `effort` with an
 * empty prompt, found by bisecting the published fit. The fit is monotone in
 * the cap: below the rung's budget tier the clamped budget grows with the cap,
 * so nothing fits, and above it the budget is constant.
 */
function answerFloorOf(shape: Shape, effort: ResolvedReasoningEffort | undefined): number {
  const key = `${shape}:${effort ?? 'none'}`;
  const cached = floorCache.get(key);
  if (cached !== undefined) return cached;
  const fitsAt = (cap: number): boolean =>
    effortFitsAnswerRoom(
      priceableOf({ id: 'vendor/floor', shape, providerCap: cap, contextLength: SEARCH_CONTEXT }),
      effort,
      0
    );
  let lo = 1;
  let hi = SEARCH_CONTEXT;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  floorCache.set(key, lo);
  return lo;
}

/**
 * Each model's graded rung: its resolved entry at the pin, read off the server's
 * own resolution, or the rung the composer grades an unpinned model at.
 */
function resolvedEfforts(
  shapes: readonly Shape[],
  effort: CanonicalReasoningEffort | undefined
): readonly (ResolvedReasoningEffort | undefined)[] {
  const probes = shapes.map((shape, index) => ({
    id: `vendor/m${String(index)}`,
    shape,
    providerCap: SEARCH_CONTEXT,
    contextLength: SEARCH_CONTEXT,
  }));
  const resolved = resolveTurnReasoning(
    probes.map((probe) => probe.id),
    resolverOf(probes),
    effort
  );
  return probes.map(
    (probe) =>
      (resolved.isOk() ? resolved.value.get(probe.id)?.effort : undefined) ??
      unpinnedEffortOf(priceableOf(probe))
  );
}

function roomedTurn(
  effort: CanonicalReasoningEffort | undefined,
  promptChars: number,
  drawn: readonly [DrawnModel, ...DrawnModel[]]
): AnswerRoomTurn {
  const promptTokens = promptInputTokensFor(budgetOf(promptChars));
  const efforts = resolvedEfforts(
    drawn.map((model) => model.shape),
    effort
  );
  const roomed = drawn.map((model, index): RoomedModel => {
    const floor = answerFloorOf(model.shape, efforts[index]);
    return {
      id: `vendor/m${String(index)}`,
      shape: model.shape,
      providerCap: Math.max(1, floor + model.capOffset),
      contextLength: Math.max(1, promptTokens + floor + model.headroomOffset),
    };
  });
  const [lead, ...siblings] = roomed;
  /* v8 ignore next -- `drawn` is non-empty by its type, so a lead always exists */
  if (lead === undefined) throw new Error('a drawn turn has at least one model');
  return { effort, promptChars, models: [lead, ...siblings] };
}

const offsetArb = fc.oneof(
  { arbitrary: fc.constantFrom(-1, 0, 1), weight: 1 },
  { arbitrary: fc.integer({ min: -40_000, max: 40_000 }), weight: 3 }
);

function drawnModelArb(shapes: readonly Shape[]): fc.Arbitrary<DrawnModel> {
  return fc.record({
    shape: fc.constantFrom(...shapes),
    capOffset: offsetArb,
    headroomOffset: offsetArb,
  });
}

/** Up to 533,334 prompt tokens at 3 characters per token. */
const promptCharsArb = fc.nat({ max: 1_600_000 });

/** A pinned rung, or none, over a full-ladder lead and up to two siblings of any shape. */
const answerRoomTurnArb: fc.Arbitrary<AnswerRoomTurn> = fc
  .record({
    effort: fc.option(fc.constantFrom(...CANONICAL_REASONING_EFFORTS), { nil: undefined }),
    lead: drawnModelArb(FULL_LADDER_SHAPES),
    siblings: fc.array(drawnModelArb(SIBLING_SHAPES), { maxLength: 2 }),
    promptChars: promptCharsArb,
  })
  .map(({ effort, lead, siblings, promptChars }) =>
    roomedTurn(effort, promptChars, [lead, ...siblings])
  );

/** One to three models that do not reason or cannot stop reasoning, with no rung pinned. */
const unpinnedTurnArb: fc.Arbitrary<AnswerRoomTurn> = fc
  .record({
    lead: drawnModelArb(UNPINNED_SHAPES),
    siblings: fc.array(drawnModelArb(UNPINNED_SHAPES), { maxLength: 2 }),
    promptChars: promptCharsArb,
  })
  .map(({ lead, siblings, promptChars }) =>
    roomedTurn(undefined, promptChars, [lead, ...siblings])
  );

function browserSends(turn: AnswerRoomTurn): boolean {
  const [lead, ...siblings] = turn.models;
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(SPENDABLE),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    {
      systemChars: turn.promptChars,
      instructionChars: 0,
      historyChars: 0,
      inputChars: 0,
      attachmentBytes: 0,
    },
    {
      answerSources: {
        models: [modelId(lead.id), ...siblings.map((model) => modelId(model.id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: turn.effort === undefined ? {} : { effort: turn.effort },
      webSearch: false,
    },
    { models: turn.models.map((model) => priceableOf(model)), nowMs: TEST_DAY_START }
  ).admissible.sendable;
}

function serverCompiles(turn: AnswerRoomTurn): boolean {
  const resolve = resolverOf(turn.models);
  const budget = budgetOf(turn.promptChars);
  const reasoning = turn.effort === undefined ? {} : { reasoningEffort: turn.effort };
  if (turn.models.length === 1) {
    return compileSingleTurn(resolve, turn.models[0].id, { budget, ...reasoning }).isOk();
  }
  return compileMultiModelTurnOutcome(
    resolve,
    turn.models.map((model) => model.id),
    { budget, ...reasoning, nowMs: TEST_DAY_START }
  ).match(
    (outcome) => outcome.kind === 'built',
    () => false
  );
}

describe('the answer room every model of a turn needs', () => {
  it('lets the server compile exactly the sends the browser admits', () => {
    fc.assert(
      fc.property(answerRoomTurnArb, (turn) => {
        expect(serverCompiles(turn)).toBe(browserSends(turn));
      })
    );
  });

  it('lets the server compile exactly the unpinned sends the browser admits', () => {
    fc.assert(
      fc.property(unpinnedTurnArb, (turn) => {
        expect(serverCompiles(turn)).toBe(browserSends(turn));
      })
    );
  });
});
