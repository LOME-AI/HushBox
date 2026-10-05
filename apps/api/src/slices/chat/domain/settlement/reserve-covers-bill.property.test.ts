/**
 * reserve ⊇ bill, proven on the settlement side. Each draw compiles a turn
 * through the production build, routed as the send route routes it: pinned
 * models, the trial's single model, the auto-effort classifier on a fan-out,
 * on a searching single model and as the effort slot, a Smart Model slot alone,
 * beside pinned siblings and classifying effort, and media. The hold is the
 * production estimator's. The turn then runs through the real engine: the real
 * `modelCall` and `smartModel` nodes with their stream serializer and cost
 * decision, the real port conversion, and the engine's own overrun capture.
 *
 * The model provider is the only faked external seam. It plays a vendor that
 * serves each step at a rate inside the ceiling of the tier the step's prompt
 * reaches, answers the classifier, plays every search inside its own loop, and
 * reports each step's inline cost as OpenRouter does. The admission hook, the
 * settlement hook and the telemetry spy are in-test stand-ins. The settlement
 * stand-in's receipt for a paid turn is its charges with the storage fees the
 * real `withStorageFees` attaches. A trial's receipt is empty, as the trial
 * commit posts nothing, so its bound is checked on the spend its daily counter
 * records, against its storage-free hold.
 *
 * Inside the enforced limits the bill never exceeds the hold. Two input
 * exceptions sit outside those limits by ruling, and are bounded and named
 * here instead: a prompt that occupies more tokens than its characters ÷ 3,
 * which may also reach a long-context tier the estimate did not; and a reply
 * that stores more than 5 characters per output token.
 *
 * Not generated, so this evidence for INV-1 does not reach them: estimated
 * billing, where a lost inline cost leaves the catalog estimate to bill; a
 * refusal that still bills; a hard abort that cuts a step in flight;
 * owner-funded and group payers; effort rungs outside `low`, `medium` and
 * `high`; and the trial route's auto-effort and Smart Model turns.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { match } from 'ts-pattern';
import {
  CATALOG_GENERATION_HEX_LENGTH,
  ERROR_CODES,
  STORAGE_COST_PER_CHARACTER_NANO,
  WEB_SEARCH_TOOL_NAME,
  applyMarkupCeilFromUsdDecimal,
} from '@hushbox/shared';
import {
  REASONING_EFFORT_LABELS,
  REASONING_OFF,
  TOOL_CALL_CAP_MAX,
  billedNanoUsd,
  parseChargeKey,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import { PROPERTY_TEST_SEED } from '@hushbox/shared/property-tests';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { createEstimateRun, createToolRegistry, snapshotResolver } from '../../../models/index.js';
import { createWorkflowExecutor } from '../../../workflows/index.js';
import { CHAT_TURN_HOOKS, TRIAL_TURN_HOOKS } from '../constants.js';
import { createTurnExecutionRegistry } from '../runtime.js';
import { compileAutoEffortTurn, compileSmartModelSend } from '../smart-model/turn.js';
import {
  compileMultiModelTurnOutcome,
  compileSingleTurn,
  createTurnCompileRegistries,
  turnInputs,
} from '../turn/definition.js';
import { MEDIA_TURN_MIME_TYPES, buildMediaTurn } from '../turn/media-turn.js';
import { withStorageFees } from './settlement.js';
import type {
  FlowHookBindings,
  FlowRunHandle,
  FlowRunOutcome,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  Node,
  ReasoningEffortSelection,
  SettlementCharge,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { InferOptions, ModelPricingResolver, ModelProvider } from '../../../models/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { MultiModelTurnBuild, TurnBudget } from '../turn/definition.js';

type RunReservation = ReturnType<ReturnType<ReturnType<typeof createEstimateRun>>['_unsafeUnwrap']>;
type ReservedCall = RunReservation['calls'][number];
type ModelNode = Extract<Node, { type: 'modelCall' } | { type: 'smartModel' }>;

/** Draws per seed for the in-limit property. */
const IN_LIMIT_RUNS = 5000;

/** A second fixed seed beside the shared one, so the in-limit property runs over two draw streams. */
const SECOND_SEED = PROPERTY_TEST_SEED ^ 0x3c_a7_91_e5;

/** Long enough for the in-limit property's two seeded runs of whole-engine turns. */
const PROPERTY_TIMEOUT_MS = 600_000;

const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const VIDEO_RESOLUTION = '720p';

const PER_MILLE = 1000;

/**
 * The dense-prompt turn's hold: 190,000 estimated prompt tokens × 4,313 and
 * 64,000 output tokens × (21,563 + 1,500 stored), plus 640 framing and 88 new
 * characters × 300.
 */
const DENSE_PROMPT_HOLD_NANO_USD = 2_295_720_400n;

/**
 * Its bill: 205,000 × $0.0000075 + 64,000 × $0.000028125 = $3.3375 served at
 * the long-context ceiling, marked up to 3,838,125,000, plus 320,088 stored
 * characters × 300.
 */
const DENSE_PROMPT_BILL_NANO_USD = 3_934_151_400n;

/** Its hold re-priced at 205,000 prompt tokens: the step reserved at the long-context ceiling. */
const DENSE_PROMPT_REPRICED_HOLD_NANO_USD = 3_934_359_400n;

/**
 * The dense-reply turn's hold: 134 prompt tokens × 1,438 and 8,192 output
 * tokens × (7,188 + 1,500 stored), plus 640 framing and 400 new characters × 300.
 */
const DENSE_REPLY_HOLD_NANO_USD = 71_676_788n;

/** Its bill: a provider cost of 59,072,625 and 352,256 + 400 stored characters × 300. */
const DENSE_REPLY_BILL_NANO_USD = 164_869_425n;

/** Its hold plus the 311,296 characters stored past 5 per output token × 300. */
const DENSE_REPLY_REPRICED_HOLD_NANO_USD = 165_065_588n;

// ---------------------------------------------------------------------------
// The vendor's prices, as integer counts of 10⁻³² USD per token or unit.
// ---------------------------------------------------------------------------

/** Fractional digits of a vendor rate as this file holds it: drawn rates use up to 30, tier rates two more. */
const RATE_DIGITS = 32;

/** The longest fractional part a drawn vendor rate carries, past the longest a vendor listing has carried. */
const VENDOR_FRACTION_DIGITS_MAX = 30;

interface VendorTokenRates {
  readonly input: bigint;
  readonly output: bigint;
}

/** A long-context row as the vendor lists it: these rates apply above `min_prompt_tokens`. */
interface VendorTier {
  readonly abovePromptTokens: number;
  readonly rates: VendorTokenRates;
}

interface TextModel {
  readonly kind: 'text';
  readonly id: string;
  readonly base: VendorTokenRates;
  readonly tiers: readonly VendorTier[];
  readonly contextLength: number;
  readonly maxOutputTokens: number;
  readonly reasons: boolean;
}

interface MediaModel {
  readonly kind: 'image' | 'video';
  readonly id: string;
  /** Per image, or per second at {@link VIDEO_RESOLUTION}. */
  readonly anchor: bigint;
  readonly dearest: bigint;
}

type CatalogModel = TextModel | MediaModel;

/** A count of 10⁻³² USD as the decimal string a vendor lists. */
function usdDecimal(units: bigint): string {
  const digits = units.toString().padStart(RATE_DIGITS + 1, '0');
  const fraction = digits.slice(-RATE_DIGITS).replace(/0+$/, '');
  const whole = digits.slice(0, -RATE_DIGITS);
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** The billable rate ingestion bakes from a vendor rate: one round-up from its exact decimal. */
function baked(units: bigint): bigint {
  const rate = applyMarkupCeilFromUsdDecimal(usdDecimal(units));
  if (rate === undefined) throw new Error('a vendor rate is always a decimal');
  return rate;
}

/** `rate × twentieths / 20`, exact: every drawn rate is a whole multiple of 100 at this scale. */
function scaled(rate: bigint, twentieths: number): bigint {
  return (rate * BigInt(twentieths)) / 20n;
}

/**
 * The vendor's own price for a request of `promptTokens`: its last row whose
 * `min_prompt_tokens` the prompt exceeds, or its base row. This is the fake
 * vendor's pricing, which the hold is checked against, never HushBox's.
 */
function vendorTierOf(
  model: TextModel,
  promptTokens: number
): { readonly index: number; readonly rates: VendorTokenRates } {
  let index = 0;
  let rates = model.base;
  for (const [position, tier] of model.tiers.entries()) {
    if (promptTokens > tier.abovePromptTokens) {
      index = position + 1;
      rates = tier.rates;
    }
  }
  return { index, rates };
}

/**
 * A rate the vendor serves inside the limits: up to five quarters of the
 * anchor's own rate at the tier, scaled by a draw out of a thousand. Baked,
 * five quarters of the anchor is at most the hold's ceiling for the tier.
 */
function servedRate(anchorRate: bigint, permille: number): bigint {
  return (anchorRate * 5n * BigInt(permille)) / (4n * BigInt(PER_MILLE));
}

/** The inline cost a vendor reports: the exact decimal amount, read into a JSON number. */
function reportedUsd(units: bigint): number {
  return Number(usdDecimal(units));
}

function textDescriptor(model: TextModel): ModelDescriptor {
  return {
    id: model.id,
    provider: 'vendor',
    version: '4',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming', 'tools'],
    limits: { contextLength: model.contextLength, maxOutputTokens: model.maxOutputTokens },
    pricing: tokenPricingFixture({
      input: baked(model.base.input),
      output: baked(model.base.output),
      tiers: model.tiers.map((tier) => ({
        abovePromptTokens: tier.abovePromptTokens,
        input: baked(tier.rates.input),
        output: baked(tier.rates.output),
      })),
      anchorContextTokens: model.contextLength,
    }),
    ...(model.reasons ? { reasoning: { supportedEfforts: ['low', 'medium', 'high'] } } : {}),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function mediaDescriptor(model: MediaModel): ModelDescriptor {
  const pricing =
    model.kind === 'image'
      ? perImagePricingFixture({ anchor: baked(model.anchor), dearest: baked(model.dearest) })
      : perSecondPricingFixture({
          anchor: { [VIDEO_RESOLUTION]: baked(model.anchor) },
          dearest: { [VIDEO_RESOLUTION]: baked(model.dearest) },
        });
  return {
    id: model.id,
    provider: 'vendor',
    version: '4',
    inputs: ['text'],
    outputs: [model.kind],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function descriptorOf(model: CatalogModel): ModelDescriptor {
  return model.kind === 'text' ? textDescriptor(model) : mediaDescriptor(model);
}
// ---------------------------------------------------------------------------
// Turns, compiled the way the send route compiles them.
// ---------------------------------------------------------------------------

interface Payer {
  readonly kind: 'purchased' | 'free';
  readonly spendableNanoUsd: bigint;
}

interface Prompt {
  /** The resent history and system prompt, which the provider sees and the turn never stores. */
  readonly historyChars: number;
  /** The new message: sent, and stored once. */
  readonly messageChars: number;
  /** The share of the prompt in a 3-byte script, out of a thousand. */
  readonly cjkPermille: number;
}

/** Pinned models: one or several, on the paid or the trial policy. */
interface TextTurnPlan {
  readonly kind: 'text';
  readonly models: readonly TextModel[];
  readonly prompt: Prompt;
  readonly payer: Payer;
  readonly trial: boolean;
  readonly webSearch: boolean;
  /** The send's reasoning selection, `auto` included, or null for a send that names none. */
  readonly effort: ReasoningEffortSelection | null;
}

/** A Smart Model slot over the turn's catalog, with its first `pinnedCount` models pinned beside it. */
interface SmartTurnPlan {
  readonly kind: 'smart';
  readonly models: readonly TextModel[];
  readonly pinnedCount: number;
  readonly slotPosition: number;
  readonly prompt: Prompt;
  readonly payer: Payer;
  readonly webSearch: boolean;
  readonly effort: 'auto' | 'off' | 'low' | 'medium' | 'high' | null;
}

interface MediaTurnPlan {
  readonly kind: 'media';
  readonly modality: 'image' | 'video';
  readonly models: readonly MediaModel[];
  readonly prompt: Prompt;
  readonly payer: Payer;
  readonly durationSeconds: number;
}

type TurnPlan = TextTurnPlan | SmartTurnPlan | MediaTurnPlan;

/** Which compile a turn took; the auto-effort and Smart Model shapes are the send route's own branches. */
type TurnShape =
  | 'single'
  | 'multi'
  | 'trial'
  | 'media'
  | 'auto-multi'
  | 'auto-search'
  | 'auto-slot'
  | 'auto-settled'
  | 'smart'
  | 'smart-siblings'
  | 'smart-auto';

/** The shapes the auto-effort and Smart Model branches compile to, each held to its own reach minimum. */
const CLASSIFIED_SHAPES: readonly TurnShape[] = [
  'auto-multi',
  'auto-search',
  'auto-slot',
  'smart',
  'smart-siblings',
  'smart-auto',
];

interface CompiledTurn {
  readonly plan: TurnPlan;
  readonly shape: TurnShape;
  readonly resolver: ModelPricingResolver;
  readonly build: MultiModelTurnBuild;
  readonly reservation: RunReservation;
}

interface ShapedBuild {
  readonly build: MultiModelTurnBuild;
  readonly shape: TurnShape;
}

/** The catalog generation a compile stamps; the in-memory engine reads no catalog to compare it with. */
const CATALOG_GENERATION = 'f'.repeat(CATALOG_GENERATION_HEX_LENGTH);

function promptChars(prompt: Prompt): number {
  return prompt.historyChars + prompt.messageChars;
}

/** The prompt's UTF-8 bytes: no tokenizer emits more tokens than these. */
function promptUtf8Bytes(prompt: Prompt): number {
  const chars = promptChars(prompt);
  return chars + 2 * Math.floor((chars * prompt.cjkPermille) / PER_MILLE);
}

function budgetOf(plan: TurnPlan): TurnBudget {
  return {
    promptCharacterCount: promptChars(plan.prompt),
    inputCharacterCount: plan.prompt.messageChars,
    funding: { kind: plan.payer.kind, spendableNanoUsd: plan.payer.spendableNanoUsd },
  };
}

function isTrial(plan: TurnPlan): boolean {
  return plan.kind === 'text' && plan.trial;
}

/** The fan-out compile, which also carries the classifier of a multi-model or searching `auto` turn. */
function fanOutBuild(
  plan: TextTurnPlan,
  catalog: readonly ModelDescriptor[],
  shape: TurnShape
): ShapedBuild | undefined {
  const compiled = compileMultiModelTurnOutcome(
    snapshotResolver(catalog),
    plan.models.map((model) => model.id),
    {
      budget: budgetOf(plan),
      webSearchEnabled: plan.webSearch,
      catalog,
      nowMs: TEST_DAY_START,
      ...(plan.effort === null ? {} : { reasoningEffort: plan.effort }),
    }
  );
  if (compiled.isErr() || compiled.value.kind !== 'built') return undefined;
  return { build: compiled.value, shape };
}

function singleBuild(
  plan: TextTurnPlan,
  catalog: readonly ModelDescriptor[],
  shape: TurnShape
): ShapedBuild | undefined {
  const [only] = plan.models;
  if (only === undefined) return undefined;
  const compiled = compileSingleTurn(snapshotResolver(catalog), only.id, {
    budget: budgetOf(plan),
    hooks: plan.trial ? TRIAL_TURN_HOOKS : CHAT_TURN_HOOKS,
    webSearchEnabled: plan.webSearch,
    ...(plan.effort === null ? {} : { reasoningEffort: plan.effort }),
  });
  return compiled.isOk() ? { build: { definition: compiled.value }, shape } : undefined;
}

/**
 * A one-model `auto` send without search: the classified effort slot, or the
 * regular turn when the effort question is already settled.
 */
function autoSlotBuild(
  plan: TextTurnPlan,
  catalog: readonly ModelDescriptor[]
): ShapedBuild | undefined {
  const [only] = plan.models;
  if (only === undefined) return undefined;
  const compiled = compileAutoEffortTurn(catalog, only.id, {
    budget: budgetOf(plan),
    hooks: CHAT_TURN_HOOKS,
    now: new Date(TEST_DAY_START),
    catalogGeneration: CATALOG_GENERATION,
  });
  if (compiled.isErr() || compiled.value.kind === 'unaffordable') return undefined;
  if (compiled.value.kind === 'fallback') return singleBuild(plan, catalog, 'auto-settled');
  return { build: compiled.value, shape: 'auto-slot' };
}

/** A pinned-model send, routed as `turn-definition.ts` routes it. */
function textBuild(
  plan: TextTurnPlan,
  catalog: readonly ModelDescriptor[]
): ShapedBuild | undefined {
  if (plan.trial) return singleBuild(plan, catalog, 'trial');
  if (plan.models.length > 1) {
    return fanOutBuild(plan, catalog, plan.effort === 'auto' ? 'auto-multi' : 'multi');
  }
  if (plan.effort !== 'auto') return singleBuild(plan, catalog, 'single');
  return plan.webSearch ? fanOutBuild(plan, catalog, 'auto-search') : autoSlotBuild(plan, catalog);
}

function smartShapeOf(plan: SmartTurnPlan): TurnShape {
  if (plan.effort === 'auto') return 'smart-auto';
  return plan.pinnedCount > 0 ? 'smart-siblings' : 'smart';
}

/** The effort fields a Smart Model send carries for its selection, as the send route maps it. */
function smartEffortArgs(effort: SmartTurnPlan['effort']): {
  readonly classifyEffort?: boolean;
  readonly reasoningOff?: boolean;
  readonly pinnedEffort?: 'low' | 'medium' | 'high';
} {
  if (effort === null) return {};
  if (effort === 'auto') return { classifyEffort: true };
  if (effort === REASONING_OFF) return { reasoningOff: true };
  return { pinnedEffort: effort };
}

async function smartBuild(
  plan: SmartTurnPlan,
  catalog: readonly ModelDescriptor[]
): Promise<ShapedBuild | undefined> {
  const compiled = await compileSmartModelSend(catalog, {
    budget: budgetOf(plan),
    pinnedModels: plan.models.slice(0, plan.pinnedCount).map((model) => model.id),
    slotPosition: plan.slotPosition,
    webSearchEnabled: plan.webSearch,
    balanceNanoUsd: plan.payer.spendableNanoUsd,
    nowMs: TEST_DAY_START,
    ...smartEffortArgs(plan.effort),
  });
  if (compiled.isErr() || !compiled.value.buildable) return undefined;
  return { build: compiled.value, shape: smartShapeOf(plan) };
}

function mediaBuild(
  plan: MediaTurnPlan,
  catalog: readonly ModelDescriptor[]
): ShapedBuild | undefined {
  const resolver = snapshotResolver(catalog);
  const registries = createTurnCompileRegistries(resolver);
  const built = buildMediaTurn({
    models: plan.models.map((model) => model.id),
    modality: plan.modality,
    params:
      plan.modality === 'video'
        ? { durationSeconds: plan.durationSeconds, resolution: VIDEO_RESOLUTION }
        : {},
    nodes: registries.nodes,
    constraints: registries.constraints,
    budget: budgetOf(plan),
    resolve: resolver,
  });
  return built.isOk() ? { build: { definition: built.value }, shape: 'media' } : undefined;
}

/** The turn as a request compiles it with the hold admission places on it, or undefined where the build refuses it. */
async function compileTurn(plan: TurnPlan): Promise<CompiledTurn | undefined> {
  const catalog = plan.models.map((model) => descriptorOf(model));
  const shaped = await match(plan)
    .with({ kind: 'text' }, (text) => textBuild(text, catalog))
    .with({ kind: 'smart' }, (smart) => smartBuild(smart, catalog))
    .with({ kind: 'media' }, (media) => mediaBuild(media, catalog))
    .exhaustive();
  if (shaped === undefined) return undefined;
  const resolver = snapshotResolver(catalog);
  const reservation = createEstimateRun(resolver)(shaped.build.definition);
  if (reservation.isErr()) return undefined;
  return {
    plan,
    shape: shaped.shape,
    resolver,
    build: shaped.build,
    reservation: reservation.value,
  };
}
// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A share out of a thousand, drawn at its top often enough that every bound is reached. */
const sharePermilleArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(PER_MILLE) },
  { weight: 1, arbitrary: fc.integer({ min: 950, max: PER_MILLE }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: PER_MILLE }) }
);

/**
 * `vendorRateArb`: a vendor rate between two bounds in 10⁻³⁰ USD, kept to a
 * drawn number of fractional digits up to {@link VENDOR_FRACTION_DIGITS_MAX},
 * and returned at this file's 10⁻³² scale.
 */
function vendorRateArb(minUnits: bigint, maxUnits: bigint): fc.Arbitrary<bigint> {
  return fc
    .record({
      units: fc.bigInt({ min: minUnits, max: maxUnits }),
      digits: fc.oneof(
        { weight: 2, arbitrary: fc.constant(VENDOR_FRACTION_DIGITS_MAX) },
        { weight: 3, arbitrary: fc.integer({ min: 6, max: VENDOR_FRACTION_DIGITS_MAX }) }
      ),
    })
    .map(({ units, digits }) => {
      const step = 10n ** BigInt(VENDOR_FRACTION_DIGITS_MAX - digits);
      const kept = units - (units % step);
      return (kept === 0n ? step : kept) * 100n;
    });
}

/** Token rates from $0.04 to $70 per million tokens. */
const tokenRateArb = vendorRateArb(4n * 10n ** 22n, 7n * 10n ** 25n);

/** A tier threshold: one the live catalog uses, or any point of the context. */
function thresholdArb(contextLength: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constantFrom(128_000, 200_000, 272_000),
    fc
      .integer({ min: 20, max: 990 })
      .map((permille) => Math.floor((contextLength * permille) / PER_MILLE))
  );
}

/**
 * The model's long-context rows: none; one at twice the base; or one or two at
 * 1.5 to 2.0 times it, never falling. A threshold at or past the context is
 * dropped, since no prompt reaches it.
 */
function tiersArb(
  base: VendorTokenRates,
  contextLength: number
): fc.Arbitrary<readonly VendorTier[]> {
  const tierAt = (abovePromptTokens: number, twentieths: number): VendorTier => ({
    abovePromptTokens,
    rates: { input: scaled(base.input, twentieths), output: scaled(base.output, twentieths) },
  });
  const graded = fc
    .uniqueArray(thresholdArb(contextLength), { minLength: 1, maxLength: 2 })
    .chain((thresholds) =>
      fc
        .array(fc.integer({ min: 30, max: 40 }), {
          minLength: thresholds.length,
          maxLength: thresholds.length,
        })
        .map((multiples) => {
          const ascending = thresholds.toSorted((a, b) => a - b);
          const rising = multiples.toSorted((a, b) => a - b);
          return ascending.map((threshold, index) => tierAt(threshold, rising[index] ?? 40));
        })
    );
  return fc
    .oneof(
      fc.constant([]),
      thresholdArb(contextLength).map((threshold) => [tierAt(threshold, 40)]),
      graded
    )
    .map((tiers) => tiers.filter((tier) => tier.abovePromptTokens < contextLength));
}

/**
 * `catalogModelArb`: a text model's anchor rates, its long-context tiers at
 * 2.0× and at 1.5× to 2.0×, its context length and its maximum output.
 */
function catalogModelArb(id: string): fc.Arbitrary<TextModel> {
  return fc
    .record({
      base: fc.record({ input: tokenRateArb, output: tokenRateArb }),
      contextLength: fc.constantFrom(16_384, 32_768, 128_000, 200_000, 400_000, 1_000_000),
      maxOutputTokens: fc.oneof(
        fc.constantFrom(1024, 8192, 32_000, 64_000),
        fc.integer({ min: 256, max: 64_000 })
      ),
      reasons: fc.boolean(),
    })
    .chain((drawn) =>
      tiersArb(drawn.base, drawn.contextLength).map(
        (tiers): TextModel => ({ kind: 'text', id, ...drawn, tiers })
      )
    );
}

/** A media model's per-unit anchor, from $0.001 to $0.30, and a dearest unit up to three times it. */
function mediaModelArb(id: string, kind: MediaModel['kind']): fc.Arbitrary<MediaModel> {
  return fc
    .record({
      anchor: vendorRateArb(10n ** 27n, 3n * 10n ** 29n),
      dearestTwentieths: fc.integer({ min: 20, max: 60 }),
    })
    .map(({ anchor, dearestTwentieths }) => ({
      kind,
      id,
      anchor,
      dearest: scaled(anchor, dearestTwentieths),
    }));
}

/** `payerArb`: the funding kind that decides the payer's tier, and spendable funds from $0.001 to $900. */
const payerArb: fc.Arbitrary<Payer> = fc.record({
  kind: fc.constantFrom('purchased' as const, 'free' as const),
  spendableNanoUsd: fc
    .tuple(fc.integer({ min: 6, max: 11 }), fc.integer({ min: 1, max: 9 }))
    .map(([exponent, mantissa]) => BigInt(mantissa) * 10n ** BigInt(exponent)),
});

/**
 * `promptArb`: history and message characters, and the share of them in a
 * 3-byte script. History runs up to nearly the whole of the smallest context,
 * so long-context tiers are reached.
 */
function promptArb(contextLength: number): fc.Arbitrary<Prompt> {
  return fc
    .record({
      messageChars: fc.integer({ min: 1, max: 4000 }),
      historyPermille: fc.oneof(
        fc.constant(0),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 950 })
      ),
      cjkPermille: fc.oneof(
        fc.constant(0),
        fc.constant(PER_MILLE),
        fc.integer({ min: 0, max: PER_MILLE })
      ),
    })
    .map(({ messageChars, historyPermille, cjkPermille }) => ({
      messageChars,
      historyChars: Math.floor((3 * contextLength * historyPermille) / PER_MILLE),
      cjkPermille,
    }));
}

const PINNED_EFFORTS = ['low', 'medium', 'high'] as const;

/** Distinct text models `text-0` … for one turn's catalog. */
function textModelsArb(min: number, max: number): fc.Arbitrary<TextModel[]> {
  return fc
    .integer({ min, max })
    .chain((count) =>
      fc.tuple(
        ...Array.from({ length: count }, (_unused, index) =>
          catalogModelArb(`text-${String(index)}`)
        )
      )
    );
}

function smallestContext(models: readonly TextModel[]): number {
  return Math.min(...models.map((model) => model.contextLength));
}

/** A send's reasoning selection: `auto` often, a pinned level where every model reasons, or none. */
function effortArb(models: readonly TextModel[]): fc.Arbitrary<ReasoningEffortSelection | null> {
  const pinned = models.every((model) => model.reasons)
    ? [fc.constantFrom<ReasoningEffortSelection>(...PINNED_EFFORTS)]
    : [];
  return fc.oneof(fc.constant(null), fc.constant<ReasoningEffortSelection>('auto'), ...pinned);
}

const textTurnPlanArb: fc.Arbitrary<TextTurnPlan> = textModelsArb(1, 3).chain((models) =>
  fc
    .record({
      kind: fc.constant('text' as const),
      models: fc.constant(models),
      prompt: promptArb(smallestContext(models)),
      payer: payerArb,
      // The trial route compiles only the plain single-model turn.
      trial: models.length === 1 ? fc.boolean() : fc.constant(false),
      webSearch: fc.boolean(),
      effort: effortArb(models),
    })
    .map((plan) => (plan.trial && plan.effort === 'auto' ? { ...plan, effort: null } : plan))
);

const smartTurnPlanArb: fc.Arbitrary<SmartTurnPlan> = textModelsArb(2, 4).chain((models) =>
  fc.integer({ min: 0, max: Math.min(2, models.length - 1) }).chain((pinnedCount) =>
    fc.record({
      kind: fc.constant('smart' as const),
      models: fc.constant(models),
      pinnedCount: fc.constant(pinnedCount),
      slotPosition: fc.integer({ min: 0, max: pinnedCount }),
      prompt: promptArb(smallestContext(models)),
      payer: payerArb,
      webSearch: fc.boolean(),
      effort: fc.oneof(
        fc.constant(null),
        { weight: 2, arbitrary: fc.constant('auto' as const) },
        fc.constant(REASONING_OFF),
        fc.constantFrom(...PINNED_EFFORTS)
      ),
    })
  )
);

const mediaTurnPlanArb: fc.Arbitrary<MediaTurnPlan> = fc
  .record({
    modality: fc.constantFrom('image' as const, 'video' as const),
    count: fc.integer({ min: 1, max: 2 }),
  })
  .chain(({ modality, count }) =>
    fc.record({
      kind: fc.constant('media' as const),
      modality: fc.constant(modality),
      models: fc.tuple(
        ...Array.from({ length: count }, (_unused, index) =>
          mediaModelArb(`${modality}-${String(index)}`, modality)
        )
      ),
      prompt: promptArb(0),
      payer: payerArb,
      durationSeconds: fc.integer({ min: 1, max: 20 }),
    })
  );

/**
 * A one-model `auto` send without search on a reasoning model: the send the
 * effort slot answers, drawn on its own because the mixed draw rarely composes it.
 */
const autoSlotPlanArb: fc.Arbitrary<TextTurnPlan> = textModelsArb(1, 1).chain((models) =>
  fc.record({
    kind: fc.constant('text' as const),
    models: fc.constant(models.map((model) => ({ ...model, reasons: true }))),
    prompt: promptArb(smallestContext(models)),
    payer: payerArb,
    trial: fc.constant(false),
    webSearch: fc.constant(false),
    effort: fc.constant<ReasoningEffortSelection>('auto'),
  })
);

/** Every turn shape the property covers, before the build admits or refuses it. */
const turnPlanArb: fc.Arbitrary<TurnPlan> = fc.oneof(
  { weight: 4, arbitrary: textTurnPlanArb },
  { weight: 1, arbitrary: autoSlotPlanArb },
  { weight: 3, arbitrary: smartTurnPlanArb },
  { weight: 1, arbitrary: mediaTurnPlanArb }
);

// ---------------------------------------------------------------------------
// What the vendor does with each call.
// ---------------------------------------------------------------------------

/** Which bounds a draw holds: all of them, or all but one of the two the hold cannot enforce. */
type Limits = 'in-limit' | 'input-overrun' | 'storage-overrun';

/** The most steps a tool loop can declare, so a call's step draws always cover the loop it runs. */
const LOOP_STEPS_MAX = toolLoopStepsFor(TOOL_CALL_CAP_MAX);

/** The most stored characters per output token a reply holds inside the limits, in tenths. */
const IN_LIMIT_DENSITY_TENTHS = 50;

/** What one step draws, before the call's bounds turn it into a play. */
interface StepDraw {
  readonly outputPermille: number;
  readonly densityTenths: number;
  readonly reasoningPermille: number;
  readonly whitespacePermille: number;
  readonly extraSearches: number;
  readonly resultPermille: number;
  readonly sources: number;
  readonly sourceChars: number;
  readonly servedInputPermille: number;
  readonly servedOutputPermille: number;
}

/** What one call draws, before its request and its reservation say what it may send. */
interface CallDraw {
  readonly stepsRunPermille: number;
  /** The true prompt as a share of what the limits allow it: the estimate, or the room above it. */
  readonly promptPermille: number;
  /** Which tier an overrunning prompt aims past, counted round the tiers the estimate stayed below. */
  readonly crossing: number;
  /** A fixed true prompt, for a pinned turn. */
  readonly promptTokens?: number;
  readonly overheadPermille: number;
  readonly steps: readonly StepDraw[];
  /** The run is stopped just before this share of the call's later steps, or never. */
  readonly drainPermille: number | null;
  /** The classifier's choice of candidate and rung, out of a thousand each, or an answer it cannot parse. */
  readonly classifierModelPermille: number;
  readonly classifierEffortPermille: number;
  readonly classifierAnswers: boolean;
  readonly bytePermille: number;
  readonly servedPermille: number;
}

/**
 * Stored characters per output token, in tenths: 1 to 5 inside the limits.
 * `storageOverrunArb`: above 5 and up to 43, as densely as a tokenizer packs whitespace runs.
 */
function densityTenthsArb(limits: Limits): fc.Arbitrary<number> {
  if (limits === 'storage-overrun') {
    return fc.integer({ min: IN_LIMIT_DENSITY_TENTHS + 1, max: 430 });
  }
  return fc.oneof(
    fc.constant(IN_LIMIT_DENSITY_TENTHS),
    fc.integer({ min: 10, max: IN_LIMIT_DENSITY_TENTHS })
  );
}

function stepDrawArb(limits: Limits): fc.Arbitrary<StepDraw> {
  return fc.record({
    outputPermille: sharePermilleArb,
    densityTenths: densityTenthsArb(limits),
    reasoningPermille: fc.integer({ min: 0, max: PER_MILLE }),
    whitespacePermille: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: PER_MILLE })),
    extraSearches: fc.integer({ min: 0, max: 3 }),
    resultPermille: sharePermilleArb,
    sources: fc.integer({ min: 0, max: 12 }),
    sourceChars: fc.integer({ min: 0, max: 400 }),
    servedInputPermille: sharePermilleArb,
    servedOutputPermille: sharePermilleArb,
  });
}

/**
 * `callOutcomeArb`: everything one call does, as shares of the bounds its
 * request and its reservation set. Steps run ≤ the loop's steps; each step's
 * output ≤ the wire cap; served rates ≤ the ceiling at the tier the step's own
 * prompt reaches; 1 to 5 stored characters per output token inside the limits;
 * searches ≤ the loop's budget; a drain point; the classifier's answer; and
 * `mediaArtifactArb`, the artifact's bytes as a share of the download cap the
 * real value store hands the call, with the vendor's cost up to the dearest
 * unit's rate.
 */
function callOutcomeArb(limits: Limits): fc.Arbitrary<CallDraw> {
  return fc.record({
    stepsRunPermille: sharePermilleArb,
    promptPermille: sharePermilleArb,
    crossing: fc.nat({ max: 5 }),
    // A dense prompt sends the whole tool-use overhead, so its first step
    // passes its reserved input whenever its prompt passes the estimate.
    overheadPermille: limits === 'input-overrun' ? fc.constant(PER_MILLE) : sharePermilleArb,
    steps: fc.array(stepDrawArb(limits), { minLength: LOOP_STEPS_MAX, maxLength: LOOP_STEPS_MAX }),
    drainPermille: fc.oneof(
      { weight: 4, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: PER_MILLE }) }
    ),
    classifierModelPermille: fc.integer({ min: 0, max: PER_MILLE - 1 }),
    classifierEffortPermille: fc.integer({ min: 0, max: PER_MILLE - 1 }),
    classifierAnswers: fc.oneof(
      { weight: 5, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) }
    ),
    bytePermille: sharePermilleArb,
    servedPermille: sharePermilleArb,
  });
}

interface Draw {
  readonly plan: TurnPlan;
  readonly limits: Limits;
  /** One draw per call the turn can make: the classifier first, then each model in catalog order. */
  readonly calls: readonly CallDraw[];
}

function drawArb(limits: Limits): fc.Arbitrary<Draw> {
  return turnPlanArb.chain((plan) =>
    fc
      .array(callOutcomeArb(limits), {
        minLength: plan.models.length + 1,
        maxLength: plan.models.length + 1,
      })
      .map((calls) => ({ plan, limits, calls }))
  );
}

interface SearchPlay {
  readonly resultTokens: number;
  readonly sources: number;
  readonly sourceChars: number;
}

interface StepPlay {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningChars: number;
  readonly answerChars: number;
  readonly whitespacePermille: number;
  /** The answer's text where it says something, as a classifier's does; otherwise filler of `answerChars`. */
  readonly answerText?: string;
  readonly searches: readonly SearchPlay[];
  readonly costUsd: number;
}

interface TextCallPlay {
  readonly kind: 'text';
  readonly wireCapTokens: number;
  /** The prompt the hold estimated, and the prompt's true token count, the same on every step. */
  readonly estimateTokens: number;
  readonly promptTokens: number;
  readonly steps: readonly StepPlay[];
  /** The run is stopped just before this step starts. */
  readonly drainBeforeStep?: number;
}

interface MediaCallPlay {
  readonly kind: 'media';
  readonly bytePermille: number;
  readonly costUsd: number;
}

type CallPlay = TextCallPlay | MediaCallPlay;

/** What a text call may send: its request's cap, its prompt's estimate, and the loop it runs within. */
interface CallBounds {
  readonly wireCapTokens: number;
  readonly estimateTokens: number;
  /** The prompt's UTF-8 bytes, which no true token count exceeds. */
  readonly promptBytes: number;
  readonly contextLength: number;
  /** The steps the call may run, as its request offers them. */
  readonly maxSteps: number;
  /** The steps the hold reserved, which decide on which steps the tool-use overhead is sent. */
  readonly reservedSteps: number;
  readonly loop?: {
    readonly resultTokens: number;
    readonly overheadTokens: number;
  };
}

/**
 * The prompt's true token count. Inside the limits it is at most the estimate
 * the hold reserved. `inputOverrunArb`: above it, up to the prompt's bytes and
 * the model's context, and sometimes just past a tier the estimate stayed below.
 */
function truePromptTokens(
  model: TextModel,
  bounds: CallBounds,
  draw: CallDraw,
  limits: Limits
): number {
  if (draw.promptTokens !== undefined) return draw.promptTokens;
  const estimate = bounds.estimateTokens;
  if (limits !== 'input-overrun') {
    return Math.max(1, Math.floor((estimate * draw.promptPermille) / PER_MILLE));
  }
  const most = Math.min(bounds.promptBytes, bounds.contextLength);
  if (most <= estimate) return estimate;
  const floors = [
    estimate,
    ...model.tiers
      .map((tier) => tier.abovePromptTokens)
      .filter((threshold) => threshold >= estimate && threshold < most),
  ];
  const from = (floors[draw.crossing % floors.length] ?? estimate) + 1;
  return from + Math.floor(((most - from) * draw.promptPermille) / PER_MILLE);
}

/**
 * The searches step `step` makes: at least one on every step but the last
 * that runs, more as drawn, while leaving one for each later searching step,
 * so the call's searches stay within the loop's budget.
 */
function searchesAt(
  bounds: CallBounds,
  at: { readonly step: number; readonly stepsRun: number; readonly left: number },
  extra: number
): number {
  if (bounds.loop === undefined || at.step >= at.stepsRun) return 0;
  const laterSearchSteps = Math.max(0, at.stepsRun - 1 - at.step);
  return Math.min(1 + extra, at.left - laterSearchSteps);
}

/** The tool-use overhead step `step` sends: only while the reserved loop still offers tools. */
function overheadAt(bounds: CallBounds, draw: CallDraw, step: number): number {
  if (bounds.loop === undefined || step > bounds.reservedSteps - 1) return 0;
  return Math.floor((bounds.loop.overheadTokens * draw.overheadPermille) / PER_MILLE);
}

/** One step as the vendor plays it, given what the steps before it sent back. */
function stepPlay(
  model: TextModel,
  bounds: CallBounds,
  draw: StepDraw,
  sent: { readonly inputTokens: number; readonly searchCount: number }
): StepPlay {
  // No endpoint the model is reached through completes more than its maximum output.
  const outputCap = Math.min(bounds.wireCapTokens, model.maxOutputTokens);
  const outputTokens = Math.floor((outputCap * draw.outputPermille) / PER_MILLE);
  const chars = Math.floor((outputTokens * draw.densityTenths) / 10);
  const reasoningChars = model.reasons
    ? Math.floor((chars * draw.reasoningPermille) / PER_MILLE)
    : 0;
  const resultTokens = Math.floor(
    ((bounds.loop?.resultTokens ?? 0) * draw.resultPermille) / PER_MILLE
  );
  const { rates } = vendorTierOf(model, sent.inputTokens);
  const costUnits =
    BigInt(sent.inputTokens) * servedRate(rates.input, draw.servedInputPermille) +
    BigInt(outputTokens) * servedRate(rates.output, draw.servedOutputPermille);
  return {
    inputTokens: sent.inputTokens,
    outputTokens,
    reasoningChars,
    answerChars: chars - reasoningChars,
    whitespacePermille: draw.whitespacePermille,
    searches: Array.from({ length: sent.searchCount }, () => ({
      resultTokens,
      sources: draw.sources,
      sourceChars: draw.sourceChars,
    })),
    costUsd: reportedUsd(costUnits),
  };
}

/**
 * Turns a call's draw into what the vendor plays. Each step sends the prompt,
 * every earlier step's output, every search result returned so far, and,
 * while tools are offered, the tool-use overhead; each part is at most what
 * the hold reserved for it.
 */
function textCallPlay(
  model: TextModel,
  bounds: CallBounds,
  draw: CallDraw,
  limits: Limits
): TextCallPlay {
  const promptTokens = truePromptTokens(model, bounds, draw, limits);
  const stepsRun = 1 + Math.floor(((bounds.maxSteps - 1) * draw.stepsRunPermille) / PER_MILLE);
  let searchesLeft = bounds.maxSteps - 1;
  let resent = 0;
  const steps: StepPlay[] = [];
  for (const [index, stepDraw] of draw.steps.slice(0, stepsRun).entries()) {
    const step = index + 1;
    const at = { step, stepsRun, left: searchesLeft };
    const searchCount = searchesAt(bounds, at, stepDraw.extraSearches);
    searchesLeft -= searchCount;
    const inputTokens = promptTokens + resent + overheadAt(bounds, draw, step);
    const played = stepPlay(model, bounds, stepDraw, { inputTokens, searchCount });
    steps.push(played);
    resent += played.outputTokens;
    for (const search of played.searches) resent += search.resultTokens;
  }
  const play: TextCallPlay = {
    kind: 'text',
    wireCapTokens: bounds.wireCapTokens,
    estimateTokens: bounds.estimateTokens,
    promptTokens,
    steps,
  };
  if (draw.drainPermille === null || stepsRun < 2) return play;
  const span = stepsRun - 2;
  return { ...play, drainBeforeStep: 2 + Math.floor((span * draw.drainPermille) / PER_MILLE) };
}

/** The labelled lines a classifier answers with, choosing among what its turn presented. */
function classifierAnswerText(turn: CompiledTurn, draw: CallDraw): string {
  const domain = turn.build.classifier?.decisionDomain;
  if (!draw.classifierAnswers || domain === undefined) return 'no choice';
  const lines: string[] = [];
  const candidate =
    domain.candidates[
      Math.floor((draw.classifierModelPermille * domain.candidates.length) / PER_MILLE)
    ];
  if (candidate !== undefined) lines.push(`model: ${candidate.id}`);
  const effort =
    domain.presentedEfforts[
      Math.floor((draw.classifierEffortPermille * domain.presentedEfforts.length) / PER_MILLE)
    ];
  if (effort !== undefined) lines.push(`effort: ${REASONING_EFFORT_LABELS[effort]}`);
  return lines.join('\n');
}

/** The classifier's one step: its answer, its prompt and its output inside the bounds of its own call. */
function classifierPlay(
  model: TextModel,
  turn: CompiledTurn,
  bounds: CallBounds,
  draw: { readonly call: CallDraw; readonly limits: Limits }
): TextCallPlay {
  const single = { ...bounds, maxSteps: 1, reservedSteps: 1 };
  const played = textCallPlay(model, single, draw.call, draw.limits);
  const [first] = played.steps;
  if (first === undefined) return played;
  const answerText = classifierAnswerText(turn, draw.call);
  return { ...played, steps: [{ ...first, reasoningChars: 0, answerText }] };
}

function mediaCallPlay(model: MediaModel, plan: TurnPlan, draw: CallDraw): MediaCallPlay {
  const seconds = plan.kind === 'media' && plan.modality === 'video' ? plan.durationSeconds : 1;
  return {
    kind: 'media',
    bytePermille: draw.bytePermille,
    costUsd: reportedUsd(
      (model.dearest * BigInt(seconds) * BigInt(draw.servedPermille)) / BigInt(PER_MILLE)
    ),
  };
}

/** The classifier node: the one model call whose value another node consumes. */
function classifierNodeId(definition: WorkflowDefinition): string | undefined {
  const consumers = new Set(definition.edges.map((edge) => edge.from.node));
  return definition.nodes.find((node) => node.type === 'modelCall' && consumers.has(node.id))?.id;
}

/** The node that answers as `modelId`: its pinned node, or the Smart Model slot offering it. */
function answeringNodeOf(turn: CompiledTurn, modelId: string): ModelNode {
  const classifier = classifierNodeId(turn.build.definition);
  const node = turn.build.definition.nodes.find(
    (candidate): candidate is ModelNode =>
      (candidate.type === 'modelCall' &&
        candidate.model === modelId &&
        candidate.id !== classifier) ||
      (candidate.type === 'smartModel' &&
        candidate.candidates.some((entry) => entry.id === modelId))
  );
  if (node === undefined)
    throw new Error('the vendor was asked for a model no answering node names');
  return node;
}

function reservedCallAt(
  turn: CompiledTurn,
  nodeId: string,
  modelId: string
): ReservedCall | undefined {
  return turn.reservation.calls.find(
    (call) => call.nodeId === nodeId && call.modelId === modelId && call.routingClassifier !== true
  );
}

/** The node a call runs for: the classifier node, or the node that answers as its model. */
function nodeOfCall(turn: CompiledTurn, modelId: string, routing: boolean): Node {
  if (!routing) return answeringNodeOf(turn, modelId);
  const id = classifierNodeId(turn.build.definition);
  const node = turn.build.definition.nodes.find((entry) => entry.id === id);
  if (node === undefined)
    throw new Error('a classifier call ran in a turn with no classifier node');
  return node;
}

/** The wire cap a language request was sent. */
function wireCapOf(request: InferenceRequest): number {
  const cap = request.parameters['maxOutputTokens'];
  if (typeof cap !== 'number') throw new Error('a language call was sent without a wire cap');
  return cap;
}

/** What the hold reserved for a node's call: its prompt estimate, its steps and its loop. */
function heldFor(
  turn: CompiledTurn,
  node: Node,
  modelId: string
): Pick<CallBounds, 'estimateTokens' | 'reservedSteps' | 'loop'> {
  const reserved = reservedCallAt(turn, node.id, modelId);
  if (reserved === undefined) {
    return { estimateTokens: promptInputTokensOf(node), reservedSteps: 1 };
  }
  const loop = reserved.quantities.loop;
  return {
    estimateTokens: reserved.quantities.promptTokens,
    reservedSteps: reserved.steps,
    ...(loop === undefined
      ? {}
      : { loop: { resultTokens: loop.resultTokens, overheadTokens: loop.overheadTokens } }),
  };
}

/**
 * What a request may send, read off the request, the options its node passed,
 * and the hold. A Smart Model candidate the hold did not reserve reads its
 * node's prompt estimate and runs no loop.
 */
function boundsOf(
  turn: CompiledTurn,
  model: TextModel,
  call: { readonly request: InferenceRequest; readonly options: InferOptions | undefined },
  routing: boolean
): CallBounds {
  const held = heldFor(turn, nodeOfCall(turn, model.id, routing), model.id);
  return {
    ...held,
    wireCapTokens: wireCapOf(call.request),
    // A classifier's prompt is an excerpt the turn assembled: up to three bytes a character.
    promptBytes: routing ? 9 * held.estimateTokens : promptUtf8Bytes(turn.plan.prompt),
    contextLength: model.contextLength,
    maxSteps: call.options?.tools?.maxSteps ?? 1,
  };
}

function promptInputTokensOf(node: Node): number {
  if (!('promptInputTokens' in node) || node.promptInputTokens === undefined) {
    throw new Error('an answering node carries no prompt estimate');
  }
  return node.promptInputTokens;
}

function textOf(chars: number, whitespacePermille: number): string {
  const spaces = Math.floor((chars * whitespacePermille) / PER_MILLE);
  const letters = chars - spaces;
  const head = Math.ceil(letters / 2);
  return `${'x'.repeat(head)}${' '.repeat(spaces)}${'x'.repeat(letters - head)}`;
}

function searchResult(search: SearchPlay): unknown {
  return {
    results: Array.from({ length: search.sources }, (_unused, index) => ({
      title: `t${String(index)}${'t'.repeat(search.sourceChars)}`,
      url: `https://example.com/${String(index)}`,
      snippet: 's'.repeat(search.sourceChars),
    })),
  };
}

/** One text call the vendor plays: the model it answers as, its play, and the run's stop. */
interface TextCallScript {
  readonly modelId: string;
  readonly play: TextCallPlay;
  readonly stopRun: () => void;
}

/** One step's content: its reasoning, its answer, and each search it makes, answered while the gate admits it. */
function* stepContent(
  modelId: string,
  index: number,
  step: StepPlay,
  options: InferOptions | undefined
): Generator<InferenceEvent> {
  if (step.reasoningChars > 0) {
    yield { kind: 'reasoning-delta', index: 0, content: textOf(step.reasoningChars, 0) };
  }
  const answer = step.answerText ?? textOf(step.answerChars, step.whitespacePermille);
  if (answer !== '') yield { kind: 'text-delta', index: 0, content: answer };
  for (const [position, search] of step.searches.entries()) {
    const id = `${modelId}-search-${String(index)}-${String(position)}`;
    yield { kind: 'tool-call', id, name: WEB_SEARCH_TOOL_NAME, args: { query: 'q' } };
    if (options?.continuation?.mayExecuteTool() === false) continue;
    yield { kind: 'tool-result', id, name: WEB_SEARCH_TOOL_NAME, result: searchResult(search) };
  }
}

/** Whether step `index` starts: the first always does; a later one once the run's spend gate admits it. */
function mayStartStep(
  script: TextCallScript,
  index: number,
  costs: readonly number[],
  options: InferOptions | undefined
): boolean {
  if (index === 0) return true;
  if (script.play.drainBeforeStep === index + 1) script.stopRun();
  return options?.continuation?.mayStartNextStep(costs) !== false;
}

async function* playText(
  script: TextCallScript,
  options: InferOptions | undefined
): AsyncGenerator<InferenceEvent> {
  await Promise.resolve();
  const { modelId, play } = script;
  const costs: number[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const [index, step] of play.steps.entries()) {
    if (!mayStartStep(script, index, costs, options)) break;
    yield { kind: 'step-start', step: index };
    yield* stepContent(modelId, index, step, options);
    yield {
      kind: 'step-finish',
      step: index,
      generationId: `${modelId}-${String(index)}`,
      usage: { inputTokens: step.inputTokens, outputTokens: step.outputTokens },
      providerCostUsd: step.costUsd,
      servedBy: 'vendor',
    };
    costs.push(step.costUsd);
    usage.inputTokens += step.inputTokens;
    usage.outputTokens += step.outputTokens;
  }
  // The adapter sums the steps' inline costs as numbers, as this does.
  const providerCostUsd = costs.reduce((total, cost) => total + cost, 0);
  yield { kind: 'finish', metadata: { usage, finishReason: 'stop', providerCostUsd } };
}

async function* playMedia(
  descriptor: ModelDescriptor,
  play: MediaCallPlay,
  options: InferOptions | undefined
): AsyncGenerator<InferenceEvent> {
  await Promise.resolve();
  const modality = descriptor.outputs[0] === 'video' ? 'video' : 'image';
  const [mimeType] = MEDIA_TURN_MIME_TYPES[modality];
  const cap = options?.downloadByteCap ?? 0;
  yield { kind: 'media-start', index: 0, modality, mimeType };
  yield {
    kind: 'media-done',
    index: 0,
    value: {
      ref: `${descriptor.id}-artifact`,
      mimeType,
      modality,
      byteLength: Math.floor((cap * play.bytePermille) / PER_MILLE),
      metadata: {},
    },
  };
  yield {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'stop',
      providerCostUsd: play.costUsd,
    },
  };
}

/** The key a call's play is recorded under: the classifier's own, or the answering model's. */
const CLASSIFIER_PLAY = 'classifier';

function modelOf(turn: CompiledTurn, modelId: string): CatalogModel {
  const model = turn.plan.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) throw new Error('a call names a model the turn did not draw');
  return model;
}

/** The draw for a call: the first for the classifier, then one per model in catalog order. */
function callDrawOf(draw: Draw, turn: CompiledTurn, key: string): CallDraw {
  const index =
    key === CLASSIFIER_PLAY ? 0 : 1 + turn.plan.models.findIndex((model) => model.id === key);
  const call = draw.calls[index];
  if (call === undefined) throw new Error('a call has no draw');
  return call;
}

/** The plays each call ran, by {@link CLASSIFIER_PLAY} or answering model. */
type Plays = Map<string, CallPlay>;

/**
 * The provider, the one faked external seam: a vendor that builds each call's
 * play from the call's request and its reservation, records it, and replays it,
 * asking the run's spend gate as the adapter does.
 */
function vendorOf(
  draw: Draw,
  turn: CompiledTurn,
  plays: Plays,
  stopRun: () => void
): ModelProvider {
  return {
    infer: (request, descriptor, options) => {
      const routing = request.routingOnly === true;
      const key = routing ? CLASSIFIER_PLAY : descriptor.id;
      const call = callDrawOf(draw, turn, key);
      const model = modelOf(turn, descriptor.id);
      if (model.kind !== 'text') {
        const play = mediaCallPlay(model, turn.plan, call);
        plays.set(key, play);
        return playMedia(descriptor, play, options);
      }
      const bounds = boundsOf(turn, model, { request, options }, routing);
      const play = routing
        ? classifierPlay(model, turn, bounds, { call, limits: draw.limits })
        : textCallPlay(model, bounds, call, draw.limits);
      plays.set(key, play);
      return playText({ modelId: descriptor.id, play, stopRun }, options);
    },
  };
}

interface Capture {
  readonly error: Error;
  readonly code: string;
}

/** An in-test telemetry spy: it records every capture and logs nothing. */
function recordingTelemetry(captures: Capture[]): Telemetry {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    captureError: (error, code) => {
      captures.push({ error, code });
    },
  };
}

interface Settled {
  readonly outcome: FlowRunOutcome;
  /** What admission was asked to hold. */
  readonly holdNanoUsd: bigint;
  /** The charges the engine handed settlement, before any storage fee. */
  readonly charges: readonly SettlementCharge[];
  /** What the settlement hook's receipt says it posted: a paid turn's charges with their storage fees, a trial's nothing. */
  readonly billed: readonly SettlementCharge[];
  readonly billedNanoUsd: bigint;
  /** What the payer is charged for the run: the paid bill, or the spend a trial's daily counter records. */
  readonly spendNanoUsd: bigint;
  readonly storageNanoUsd: bigint;
  /** The legs the engine's capture named, or undefined when it raised none. */
  readonly overrunLegs: readonly string[] | undefined;
  readonly overrunCaptures: number;
  readonly drained: boolean;
  readonly plays: ReadonlyMap<string, CallPlay>;
}

function legsOf(error: Error): readonly string[] {
  return 'legs' in error && typeof error.legs === 'string' ? error.legs.split(',') : [];
}

/** The in-test admission stand-in: it records the estimate and grants with a cost circuit that never trips. */
function grantingAdmission(holds: bigint[]): FlowHookBindings['admission'] {
  return (request) => {
    holds.push(request.estimate);
    // The circuit only refuses new spend, so one that never trips lets every played step run.
    const grant = {
      admitted: true as const,
      holdRef: 'hold',
      circuit: {
        estimateNanoUsd: request.estimate,
        costCircuitMultiplier: 1000n,
        costCircuitLimitNanoUsd: request.estimate * 1000n,
      },
    };
    return Promise.resolve(grant);
  };
}

/**
 * Runs one compiled draw through the real engine and settles it. The settlement
 * hook is an in-test stand-in for the two commits: a paid turn's receipt is its
 * charges with the storage fees the real `withStorageFees` attaches; a trial's
 * receipt is empty, as its commit posts nothing, and its charges are the spend
 * its daily counter records.
 */
async function settle(draw: Draw, turn: CompiledTurn): Promise<Settled> {
  const captures: Capture[] = [];
  const telemetry = recordingTelemetry(captures);
  const plays: Plays = new Map();
  const run: { handle?: FlowRunHandle; drained: boolean } = { drained: false };
  const provider = vendorOf(draw, turn, plays, () => {
    run.drained = true;
    run.handle?.stop('user-stop');
  });
  const compile = createTurnCompileRegistries(turn.resolver);
  const executor = createWorkflowExecutor({
    registries: { nodes: compile.nodes, constraints: compile.constraints },
    execution: createTurnExecutionRegistry({
      provider,
      tools: createToolRegistry({
        search: { search: () => Promise.reject(new Error('the vendor plays every search')) },
      }),
      models: compile.models,
      compute: compile.compute,
      constraints: compile.constraints,
      telemetry,
    }),
    estimateRun: createEstimateRun(turn.resolver),
    clock: { now: () => TEST_DAY_START },
    rng: { random: () => 0.5 },
    telemetry,
  });
  const holds: bigint[] = [];
  let charges: readonly SettlementCharge[] = [];
  let billed: readonly SettlementCharge[] = [];
  const trial = isTrial(turn.plan);
  const handle = executor.start({
    definition: turn.build.definition,
    inputs: turnInputs(turn.build, 'm'.repeat(turn.plan.prompt.messageChars), []),
    hooks: {
      admission: grantingAdmission(holds),
      settlement: (request) => {
        charges = request.charges;
        billed = trial ? [] : withStorageFees(request, turn.plan.prompt.messageChars);
        return Promise.resolve({ billed });
      },
    },
    runKey: 'run-key',
    runId: 'run-id',
    emit: () => undefined,
  });
  run.handle = handle;
  const outcome = await handle.done;
  const overruns = captures.filter(
    (capture) => capture.code === FINGERPRINT_CODES.settlementAboveHold
  );
  const [overrun] = overruns;
  return {
    outcome,
    holdNanoUsd: holds[0] ?? 0n,
    charges,
    billed,
    billedNanoUsd: billedNanoUsd(billed),
    spendNanoUsd: billedNanoUsd(trial ? charges : billed),
    storageNanoUsd: billed.reduce((sum, charge) => sum + (charge.storageFeeNanoUsd ?? 0n), 0n),
    overrunLegs: overrun === undefined ? undefined : legsOf(overrun.error),
    overrunCaptures: overruns.length,
    drained: run.drained,
    plays,
  };
}

/** A draw compiled and settled, or undefined where the build refuses the turn before any run. */
interface Run {
  readonly turn: CompiledTurn;
  readonly settled: Settled;
}

async function runDraw(draw: Draw): Promise<Run | undefined> {
  const turn = await compileTurn(draw.plan);
  if (turn === undefined) return undefined;
  return { turn, settled: await settle(draw, turn) };
}

/** Runs a draw the build admits; a draw it refuses is skipped and drawn again. */
async function admittedRun(draw: Draw): Promise<Run> {
  const run = await runDraw(draw);
  fc.pre(run !== undefined);
  return run;
}

// ---------------------------------------------------------------------------
// What each bound is, read off the reservation and the vendor.
// ---------------------------------------------------------------------------

function isDefect(outcome: FlowRunOutcome): boolean {
  return outcome.outcome === 'failed' && outcome.code === ERROR_CODES.INTERNAL;
}

/** The storage the hold reserved: every call's storage part, or the whole hold when no call carries it. */
function reservedStorageNanoUsd(reservation: RunReservation): bigint {
  if (reservation.calls.length === 0) return reservation.totalNanoUsd;
  return reservation.calls.reduce((sum, call) => sum + call.storageNanoUsd, 0n);
}

/**
 * The reserved calls a charge is read against, as the detector reads them: its
 * own model's call at its node, when the hold reserved one; otherwise, for a
 * Smart Model candidate cheaper than the one its slot reserved, the node's
 * answer call, against which only the token legs are judged.
 */
function callsBounding(
  turn: CompiledTurn,
  charge: SettlementCharge
): { readonly own: ReservedCall | undefined; readonly bound: ReservedCall | undefined } {
  const { nodeId } = parseChargeKey(charge.key);
  const own = reservedCallAt(turn, nodeId, charge.modelId);
  if (own !== undefined) return { own, bound: own };
  let bound: ReservedCall | undefined;
  for (const call of turn.reservation.calls) {
    if (call.nodeId !== nodeId || call.routingClassifier === true) continue;
    if (bound === undefined || call.steps > bound.steps) bound = call;
  }
  return { own: undefined, bound };
}

/** Whether a billed step's prompt reached a vendor tier above the one its own model's reservation held it at. */
function crossedTier(turn: CompiledTurn, settled: Settled): boolean {
  return settled.billed.some((charge) => {
    const model = modelOf(turn, charge.modelId);
    const { own } = callsBounding(turn, charge);
    if (model.kind !== 'text' || own === undefined) return false;
    return (charge.observed?.stepUsages ?? []).some((step, index) => {
      const reserved = own.stepTiers[Math.min(index, own.steps - 1)] ?? 0;
      return vendorTierOf(model, step.inputTokens).index > reserved;
    });
  });
}

/**
 * The input the hold reserved for step `step` of a call, stated here rather
 * than read from the price core: the prompt's estimate, every earlier step's
 * output at the wire cap, every search result once a search can have run, and
 * the tool-use overhead while tools are offered.
 */
function reservedStepInput(call: ReservedCall, step: number): number {
  const { loop, promptTokens } = call.quantities;
  const resent = (step - 1) * call.wireCapTokens;
  if (loop === undefined) return promptTokens + resent;
  const results = step >= 2 ? loop.calls * loop.resultTokens : 0;
  const overhead = step <= call.steps - 1 ? loop.overheadTokens : 0;
  return promptTokens + resent + results + overhead;
}

/** Whether a billed step sent more input than the call it is read against reserved for that step. */
function inputPassedEstimate(turn: CompiledTurn, settled: Settled): boolean {
  return settled.billed.some((charge) => {
    const { bound } = callsBounding(turn, charge);
    if (bound === undefined || bound.wireCapTokens === 0) return false;
    return (charge.observed?.stepUsages ?? []).some(
      (step, index) => step.inputTokens > reservedStepInput(bound, Math.min(index + 1, bound.steps))
    );
  });
}

/** Whether a billed step's output passed the wire cap of the call it is read against. */
function outputPassedCap(turn: CompiledTurn, settled: Settled): boolean {
  return settled.billed.some((charge) => {
    const { bound } = callsBounding(turn, charge);
    if (bound === undefined || bound.wireCapTokens === 0) return false;
    return (charge.observed?.stepUsages ?? []).some(
      (step) => step.outputTokens > bound.wireCapTokens
    );
  });
}

/** The legs whose bound this run truly broke, judged as the detector judges each charge. */
function trulyExceeded(turn: CompiledTurn, settled: Settled): ReadonlySet<string> {
  const legs = new Set<string>();
  if (inputPassedEstimate(turn, settled)) legs.add('input-above-estimate');
  if (outputPassedCap(turn, settled)) legs.add('output-above-wire-cap');
  if (crossedTier(turn, settled)) legs.add('tier-crossed');
  if (settled.storageNanoUsd > reservedStorageNanoUsd(turn.reservation)) {
    legs.add('storage-above-allowance');
  }
  return legs;
}

/** The key a node's call was recorded under, where it ran. */
function playKeyOf(turn: CompiledTurn, settled: Settled, node: Node): string | undefined {
  if (node.id === classifierNodeId(turn.build.definition)) return CLASSIFIER_PLAY;
  if (node.type === 'modelCall') return node.model;
  if (node.type !== 'smartModel') return undefined;
  return node.candidates.find((candidate) => settled.plays.has(candidate.id))?.id;
}

/** The true prompt a node's call was played with, where it ran. */
function observedPromptOf(turn: CompiledTurn, settled: Settled, node: Node): number | undefined {
  const key = playKeyOf(turn, settled, node);
  const play = key === undefined ? undefined : settled.plays.get(key);
  return play?.kind === 'text' ? play.promptTokens : undefined;
}

/** The hold the production estimator places on the same turn priced at each call's true prompt tokens. */
function holdAtObservedInput(turn: CompiledTurn, settled: Settled): bigint {
  const { definition } = turn.build;
  const observed: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (!('promptInputTokens' in node) || node.promptInputTokens === undefined) return node;
      const promptInputTokens = observedPromptOf(turn, settled, node);
      return promptInputTokens === undefined ? node : { ...node, promptInputTokens };
    }),
  };
  return createEstimateRun(turn.resolver)(observed)._unsafeUnwrap().totalNanoUsd;
}

/** The characters a billed call stored past the in-limit density, step by step. */
function charsPastDensity(play: CallPlay | undefined, stepsBilled: number): number {
  if (play?.kind !== 'text') return 0;
  let excess = 0;
  for (const step of play.steps.slice(0, stepsBilled)) {
    const chars = step.reasoningChars + step.answerChars;
    const allowed = Math.floor((step.outputTokens * IN_LIMIT_DENSITY_TENTHS) / 10);
    excess += Math.max(0, chars - allowed);
  }
  return excess;
}

/**
 * The hold re-priced at the stored characters observed: the hold plus the
 * storage of every character a reply stored past the in-limit density. A Smart
 * Model slot holds its dearest candidate whole, provider and storage together,
 * so a cheaper candidate's split between the two is not the hold's; only the
 * whole is a bound.
 */
function holdAtObservedStorage(turn: CompiledTurn, settled: Settled): bigint {
  const classifier = classifierNodeId(turn.build.definition);
  let excess = 0;
  for (const charge of settled.billed) {
    if (parseChargeKey(charge.key).nodeId === classifier) continue;
    const steps = charge.observed?.stepUsages.length ?? 0;
    excess += charsPastDensity(settled.plays.get(charge.modelId), steps);
  }
  return turn.reservation.totalNanoUsd + BigInt(excess) * STORAGE_COST_PER_CHARACTER_NANO;
}

/** What the generators reached, counted over the runs one property settles. */
interface Reach {
  /** Billed replies with a step at 95% of its wire cap or more. */
  nearCapReplies: number;
  storageOverruns: number;
  /** Billed calls that ran 3 steps or more. */
  longLoops: number;
  /** Runs stopped mid-call that still billed. */
  drainedRuns: number;
  /** Media turns that billed an artifact. */
  mediaTurns: number;
  /** In-limit bills at 99% of their hold or more. */
  tightBills: number;
  /** Billed runs of each shape the auto-effort and Smart Model branches compile to. */
  readonly shapes: Map<TurnShape, number>;
}

/** The least each counter but the tightness one must reach for the property to be read as covering it. */
const REACH_MINIMUM = 25;

function countChargeReach(reach: Reach, turn: CompiledTurn, charge: SettlementCharge): void {
  const steps = charge.observed?.stepUsages ?? [];
  const cap = callsBounding(turn, charge).bound?.wireCapTokens ?? 0;
  reach.nearCapReplies += Number(
    steps.some((step) => cap > 0 && step.outputTokens * 100 >= cap * 95)
  );
  reach.longLoops += Number(steps.length >= 3);
}

function countReach(reach: Reach, draw: Draw, run: Run): void {
  const { turn, settled } = run;
  for (const charge of settled.billed) countChargeReach(reach, turn, charge);
  const storageReserved = reservedStorageNanoUsd(turn.reservation);
  reach.storageOverruns += Number(settled.storageNanoUsd > storageReserved);
  reach.drainedRuns += Number(settled.drained && settled.spendNanoUsd > 0n);
  reach.mediaTurns += Number(turn.shape === 'media' && settled.billed.length > 0);
  const tight = settled.spendNanoUsd * 100n >= settled.holdNanoUsd * 99n;
  reach.tightBills += Number(draw.limits === 'in-limit' && tight);
  if (settled.spendNanoUsd > 0n)
    reach.shapes.set(turn.shape, (reach.shapes.get(turn.shape) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// The properties.
// ---------------------------------------------------------------------------

describe('reserve ⊇ bill, settled', () => {
  it(
    'bills no more than the hold for every generated outcome inside the enforced limits',
    async () => {
      for (const seed of [PROPERTY_TEST_SEED, SECOND_SEED]) {
        await fc.assert(
          fc.asyncProperty(drawArb('in-limit'), async (draw) => {
            const { turn, settled } = await admittedRun(draw);
            expect(isDefect(settled.outcome)).toBe(false);
            expect(settled.holdNanoUsd).toBe(turn.reservation.totalNanoUsd);
            expect(settled.spendNanoUsd).toBeLessThanOrEqual(settled.holdNanoUsd);
            expect(settled.overrunLegs).toBeUndefined();
          }),
          { numRuns: IN_LIMIT_RUNS, seed }
        );
      }
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'bounds a dense-input overrun by the input it under-reserved',
    async () => {
      await fc.assert(
        fc.asyncProperty(drawArb('input-overrun'), async (draw) => {
          const { turn, settled } = await admittedRun(draw);
          expect(isDefect(settled.outcome)).toBe(false);
          expect(settled.spendNanoUsd).toBeLessThanOrEqual(holdAtObservedInput(turn, settled));
          if (isTrial(turn.plan) || settled.spendNanoUsd <= settled.holdNanoUsd) return;
          expect(settled.overrunLegs).toContain('input-above-estimate');
          if (crossedTier(turn, settled)) expect(settled.overrunLegs).toContain('tier-crossed');
        })
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'names at least one leg, each truly exceeded, whenever a bill passes its hold',
    async () => {
      const mixedArb = fc.oneof(
        drawArb('in-limit'),
        drawArb('input-overrun'),
        drawArb('storage-overrun')
      );
      await fc.assert(
        fc.asyncProperty(mixedArb, async (draw) => {
          const { turn, settled } = await admittedRun(draw);
          // A trial's receipt is empty, and the detector reads only the receipt.
          if (isTrial(turn.plan) || settled.billedNanoUsd <= settled.holdNanoUsd) {
            expect(settled.overrunCaptures).toBe(0);
            return;
          }
          expect(settled.overrunCaptures).toBe(1);
          expect(settled.overrunLegs?.length ?? 0).toBeGreaterThan(0);
          const truly = trulyExceeded(turn, settled);
          for (const leg of settled.overrunLegs ?? []) expect(truly).toContain(leg);
        })
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'bounds a dense-reply storage overrun by the characters it under-reserved',
    async () => {
      await fc.assert(
        fc.asyncProperty(drawArb('storage-overrun'), async (draw) => {
          const { turn, settled } = await admittedRun(draw);
          expect(isDefect(settled.outcome)).toBe(false);
          expect(settled.spendNanoUsd).toBeLessThanOrEqual(holdAtObservedStorage(turn, settled));
          if (isTrial(turn.plan) || settled.spendNanoUsd <= settled.holdNanoUsd) return;
          expect(settled.overrunLegs).toContain('storage-above-allowance');
        })
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'reaches near-cap replies, storage overruns, tool loops, drains and media, so the property is not vacuous',
    async () => {
      const reach: Reach = {
        nearCapReplies: 0,
        storageOverruns: 0,
        longLoops: 0,
        drainedRuns: 0,
        mediaTurns: 0,
        tightBills: 0,
        shapes: new Map(),
      };
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(drawArb('in-limit'), drawArb('storage-overrun')),
          async (draw) => {
            countReach(reach, draw, await admittedRun(draw));
          }
        )
      );
      expect(reach.nearCapReplies).toBeGreaterThanOrEqual(REACH_MINIMUM);
      expect(reach.storageOverruns).toBeGreaterThanOrEqual(REACH_MINIMUM);
      expect(reach.longLoops).toBeGreaterThanOrEqual(REACH_MINIMUM);
      expect(reach.drainedRuns).toBeGreaterThanOrEqual(REACH_MINIMUM);
      expect(reach.mediaTurns).toBeGreaterThanOrEqual(REACH_MINIMUM);
      expect(reach.tightBills).toBeGreaterThanOrEqual(1);
      for (const shape of CLASSIFIED_SHAPES) {
        expect(reach.shapes.get(shape) ?? 0, shape).toBeGreaterThanOrEqual(REACH_MINIMUM);
      }
    },
    PROPERTY_TIMEOUT_MS
  );
});

// ---------------------------------------------------------------------------
// The two input exceptions, each at one pinned turn.
// ---------------------------------------------------------------------------

/** One vendor step played at its whole cap and at the ceiling of its tier. */
function fullStep(densityTenths: number, whitespacePermille: number): StepDraw {
  return {
    outputPermille: PER_MILLE,
    densityTenths,
    reasoningPermille: 0,
    whitespacePermille,
    extraSearches: 0,
    resultPermille: 0,
    sources: 0,
    sourceChars: 0,
    servedInputPermille: PER_MILLE,
    servedOutputPermille: PER_MILLE,
  };
}

/** A single-model paid turn over `model`, played as one full step, with `promptTokens` true prompt tokens when given. */
function pinnedDraw(
  model: TextModel,
  prompt: Prompt,
  limits: Limits,
  play: { readonly promptTokens?: number; readonly step: StepDraw }
): Draw {
  const call: CallDraw = {
    stepsRunPermille: PER_MILLE,
    promptPermille: PER_MILLE,
    crossing: 0,
    ...(play.promptTokens === undefined ? {} : { promptTokens: play.promptTokens }),
    overheadPermille: PER_MILLE,
    steps: [play.step],
    drainPermille: null,
    classifierModelPermille: 0,
    classifierEffortPermille: 0,
    classifierAnswers: true,
    bytePermille: PER_MILLE,
    servedPermille: PER_MILLE,
  };
  return {
    plan: {
      kind: 'text',
      models: [model],
      prompt,
      payer: { kind: 'purchased', spendableNanoUsd: 1_000_000_000_000n },
      trial: false,
      webSearch: false,
      effort: null,
    },
    limits,
    calls: [call, call],
  };
}

async function pinnedRun(draw: Draw): Promise<Run> {
  const run = await runDraw(draw);
  if (run === undefined) throw new Error('the pinned turn compiles');
  return run;
}

/** USD per token at this file's 10⁻³² scale. */
function usdPerToken(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(`${whole}${fraction.padEnd(RATE_DIGITS, '0')}`);
}

describe('the two input exceptions, pinned', () => {
  it('bills a dense prompt past a long-context tier above its hold, naming the input and the tier', async () => {
    // Above 200,000 prompt tokens the input rate doubles and the output rate rises by half.
    const model: TextModel = {
      kind: 'text',
      id: 'text-dense-prompt',
      base: { input: usdPerToken('0.000003'), output: usdPerToken('0.000015') },
      tiers: [
        {
          abovePromptTokens: 200_000,
          rates: { input: usdPerToken('0.000006'), output: usdPerToken('0.0000225') },
        },
      ],
      contextLength: 1_000_000,
      maxOutputTokens: 64_000,
      reasons: false,
    };
    // 570,000 characters of a 3-byte script, estimated at 190,000 tokens, that occupy 205,000.
    const draw = pinnedDraw(
      model,
      { historyChars: 569_912, messageChars: 88, cjkPermille: PER_MILLE },
      'input-overrun',
      { promptTokens: 205_000, step: fullStep(50, 0) }
    );

    const { turn, settled } = await pinnedRun(draw);

    expect(settled.outcome).toEqual({ outcome: 'succeeded' });
    expect(settled.holdNanoUsd).toBe(DENSE_PROMPT_HOLD_NANO_USD);
    expect(settled.billedNanoUsd).toBe(DENSE_PROMPT_BILL_NANO_USD);
    expect(settled.overrunLegs).toEqual(['input-above-estimate', 'tier-crossed']);
    expect(holdAtObservedInput(turn, settled)).toBe(DENSE_PROMPT_REPRICED_HOLD_NANO_USD);
  });

  it('bills a reply of 43 characters per token above its hold, naming the storage', async () => {
    const model: TextModel = {
      kind: 'text',
      id: 'text-dense-reply',
      base: { input: usdPerToken('0.000001'), output: usdPerToken('0.000005') },
      tiers: [],
      contextLength: 128_000,
      maxOutputTokens: 8192,
      reasons: false,
    };
    // Every output token stores 43 characters, nine tenths of them a whitespace run.
    const draw = pinnedDraw(
      model,
      { historyChars: 0, messageChars: 400, cjkPermille: 0 },
      'storage-overrun',
      { step: fullStep(430, 900) }
    );

    const { turn, settled } = await pinnedRun(draw);

    expect(settled.outcome).toEqual({ outcome: 'succeeded' });
    expect(settled.holdNanoUsd).toBe(DENSE_REPLY_HOLD_NANO_USD);
    expect(settled.billedNanoUsd).toBe(DENSE_REPLY_BILL_NANO_USD);
    expect(settled.overrunLegs).toEqual(['storage-above-allowance']);
    expect(holdAtObservedStorage(turn, settled)).toBe(DENSE_REPLY_REPRICED_HOLD_NANO_USD);
  });
});
