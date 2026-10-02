/**
 * A candidate row whose ADD refuses for a reason no sibling can impose — the
 * arm `activationFor` reaches when the row replaces cleanly and the refusal is
 * still the model's — cannot appear on a turn that SENDS. Established over
 * generated arrangements rather than over chosen ones, because the pairing is
 * money-adjacent: a turn that sends is priced, held against and charged for,
 * and such a row invites the payer to swap a whole selection for a model the
 * same evaluation is refusing.
 *
 * It is pinned on `evaluateTurn` rather than on the producer above it, so it
 * binds both option sets: `getTurnOptions` is this one core at two
 * (funding, basis) pairs.
 *
 * ## The durable fact, and why it is a property rather than a coincidence
 *
 * The arm is entered only when `selectionBlock` returns a refusal outside
 * `SELECTION_CAUSED_REASONS`, and `option_not_offered` is the only such code it
 * can return: every other code `siblingBlock` produces — the tier axis's, and
 * the ceiling bound's — is a member of that set.
 *
 * A sibling yields `option_not_offered` only when the pin does not resolve on
 * its own ladder AND it is not granted wire-silence, and wire-silence is a
 * DISJUNCTION over the turn's answer sources with the candidate appended
 * (`selectionBlock` moves the candidate into `answerModels`). So reaching the
 * arm implies that no answer source resolves the pin, the candidate included.
 *
 * Every presented arrangement's siblings are drawn from those same answer
 * sources — the pinned models with the slot off, the pinned models and the
 * classifier pool with it on. None of them resolves the pin either, and the
 * same false disjunction denies every one of them wire-silence, so every
 * presented arrangement blocks, the send gate has nothing running, and the turn
 * refuses. Adding a candidate only widens the disjunction: it can clear the
 * code and can never impose it.
 *
 * ## What the sweep adds over the argument
 *
 * The argument is about one function's quantifiers; the sweep is about the
 * composition that actually runs. It moves the catalogue, the ladder kinds in
 * it, the pinned set, the slot, the pin, the funding, the tier and the prompt,
 * so a change anywhere in that composition that widened `answerModels`,
 * narrowed the presented arrangements, or turned the disjunction into a
 * conjunction is caught here rather than by re-deriving the argument.
 *
 * The counters are what stop the property being a restatement of the
 * generator's bounds: a sweep that never reached the arm, or never sent, would
 * satisfy it while constraining nothing. The sharpest of them re-evaluates each
 * arm-reaching draw with the pin REMOVED and requires many of those to send —
 * which establishes that the turn was refused BY THE PIN, rather than by an
 * empty balance that would have refused it whatever the arm did.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dimensionSupportFor, resolveOption } from '../dimensions/derive.ts';
import { EFFORT_DIMENSION, EFFORT_OPTION_IDS } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { USER_TIERS } from '../money/tiers.ts';
import { evaluateTurn } from './turn-core.ts';
import { REFUSAL_CODES, isSelectionCaused } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { CoreInput } from './turn-core.ts';
import type { OptionId } from '../dimensions/types.ts';
import type {
  AnswerSources,
  CandidateModelEntry,
  ModelEntry,
  OptionSet,
  PromptBasis,
  RefusalCode,
  Selection,
} from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/** The pin domain in full, plus the open axis. */
const PINS = [undefined, ...EFFORT_OPTION_IDS] as const;

interface PoolShape {
  readonly id: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly contextLength: number;
  readonly providerCap: number;
  /** Released at the snapshot instant, which is what premium recency reads. */
  readonly recent?: true;
  readonly reasoning?: PriceableModel['reasoning'];
}

function modelOf(shape: PoolShape): PriceableModel {
  return {
    modelId: modelId(shape.id),
    pricing: tokenPricingFixture({
      input: nanoUSD(shape.inputRate),
      output: nanoUSD(shape.outputRate),
    }),
    contextLength: shape.contextLength,
    providerCap: shape.providerCap,
    releasedAtMs: shape.recent === true ? NOW_MS : 0,
    reasoning: shape.reasoning,
  };
}

/**
 * The silent pool: the models an effort pin resolves on at NO rung of the
 * domain, which is what the arm needs every answer source to be drawn from.
 *
 * The condition is a property of the model's effort SUPPORT and not of whether
 * it carries reasoning metadata. `resolveOption` can only return an option the
 * support offers — exactly, nearest-below, or the mandatory carve-out — so a
 * support that offers nothing resolves nothing at every rung; and a support
 * offers nothing exactly when the model contributes no ladder rung AND the off
 * rung is withheld from it. Carrying a reasoning object settles neither half: a
 * model that mandates reasoning and enumerates no native word is offered no
 * rung and denied the off rung, and so belongs here.
 *
 * Membership is checked rather than asserted: {@link resolvesSomeRung} drives
 * `dimensionSupportFor` and `resolveOption` at every member of
 * `EFFORT_OPTION_IDS` — the authority `effortGate` in `turn-core.ts` reads —
 * and a membership test requires it to hold of no model here and of every
 * member of {@link LADDERED_SHAPES}. The sweep classifies a catalogue through
 * that same predicate, so it reads what resolves rather than what is present.
 *
 * They differ on the axes that decide WHICH refusal wins a precedence
 * reduction — price (the outlier median and the premium percentile), context
 * length (`prompt_too_long`), and an output cap below the minimum-answer floor
 * (`model_output_cap_too_low`) — so the arm is reached beside every other code
 * rather than only in the cheap corner.
 */
const SILENT_SHAPES: readonly PoolShape[] = [
  {
    id: 'vendor/silent-cheap',
    inputRate: 60n,
    outputRate: 150n,
    contextLength: 200_000,
    providerCap: 64_000,
  },
  {
    id: 'vendor/silent-mid',
    inputRate: 900n,
    outputRate: 2400n,
    contextLength: 64_000,
    providerCap: 16_000,
  },
  {
    id: 'vendor/silent-narrow',
    inputRate: 400n,
    outputRate: 900n,
    contextLength: 3000,
    providerCap: 2000,
  },
  {
    id: 'vendor/silent-capped',
    inputRate: 300n,
    outputRate: 700n,
    contextLength: 128_000,
    providerCap: 512,
  },
  {
    id: 'vendor/silent-recent',
    inputRate: 2000n,
    outputRate: 6000n,
    contextLength: 128_000,
    providerCap: 32_000,
    recent: true,
  },
  {
    id: 'vendor/silent-dear',
    inputRate: 40_000n,
    outputRate: 120_000n,
    contextLength: 128_000,
    providerCap: 32_000,
  },
  {
    id: 'vendor/silent-mandatory-empty',
    inputRate: 1200n,
    outputRate: 3000n,
    contextLength: 96_000,
    providerCap: 24_000,
    reasoning: { supportedEfforts: [], mandatory: true },
  },
  {
    id: 'vendor/silent-mandatory-none',
    inputRate: 250n,
    outputRate: 600n,
    contextLength: 32_000,
    providerCap: 8000,
    reasoning: { supportedEfforts: ['none'], mandatory: true },
  },
];

/** Every other shape a catalogue can carry, each of which resolves at some rung. */
const LADDERED_SHAPES: readonly PoolShape[] = [
  {
    id: 'vendor/native-full',
    inputRate: 800n,
    outputRate: 1600n,
    contextLength: 128_000,
    providerCap: 8000,
    reasoning: { supportedEfforts: null },
  },
  {
    id: 'vendor/budget-full',
    inputRate: 500n,
    outputRate: 1200n,
    contextLength: 100_000,
    providerCap: 32_000,
    reasoning: {},
  },
  {
    id: 'vendor/three-rung',
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 100_000,
    providerCap: 32_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    id: 'vendor/mandatory-one',
    inputRate: 2500n,
    outputRate: 9000n,
    contextLength: 32_000,
    providerCap: 12_000,
    reasoning: { supportedEfforts: ['high'], mandatory: true },
  },
  {
    id: 'vendor/off-only',
    inputRate: 700n,
    outputRate: 1500n,
    contextLength: 64_000,
    providerCap: 16_000,
    reasoning: { supportedEfforts: [] },
  },
  {
    id: 'vendor/three-rung-recent',
    inputRate: 1500n,
    outputRate: 4000n,
    contextLength: 64_000,
    providerCap: 16_000,
    recent: true,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
];

/**
 * Whether an effort pin resolves on this model at any rung of the domain, read
 * through the authority `effortGate` in `turn-core.ts` reads rather than
 * through the presence of a reasoning object — a model can carry one and still
 * offer nothing, so presence is not resolution.
 */
function resolvesSomeRung(model: PriceableModel): boolean {
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  return EFFORT_OPTION_IDS.some(
    (pin) => resolveOption(EFFORT_DIMENSION, support, pin) !== undefined
  );
}

const SILENT_POOL = SILENT_SHAPES.map((shape) => modelOf(shape));
const LADDERED_POOL = LADDERED_SHAPES.map((shape) => modelOf(shape));
const FULL_POOL = [...SILENT_POOL, ...LADDERED_POOL];

/** An id no catalogue prices, which is what puts a `model_not_priceable` row in a set. */
const GHOST_ID = modelId('vendor/unpriced');

/** A branch taken on `numerator` draws in every hundred. */
function inPercent(numerator: number): fc.Arbitrary<boolean> {
  return fc.oneof(
    { weight: numerator, arbitrary: fc.constant(true) },
    { weight: 100 - numerator, arbitrary: fc.constant(false) }
  );
}

/**
 * A subset of `items`, non-empty, in an arbitrary order, and uniform over its
 * SIZE — the library's own subset draw is not, and both ends of the size range
 * are shapes the counters below require.
 */
function subsetOf<T>(
  items: readonly T[],
  { minLength = 1, maxLength = items.length }: { minLength?: number; maxLength?: number } = {}
): fc.Arbitrary<T[]> {
  return fc
    .integer({ min: minLength, max: maxLength })
    .chain((size) => fc.shuffledSubarray([...items], { minLength: size, maxLength: size }));
}

/**
 * A catalogue, drawn either from the whole pool or from the silent part of it.
 * The restricted draw is deliberate rather than left to chance: the arm needs
 * EVERY answer source to be silent, which a uniform draw over a mixed pool
 * reaches vanishingly often with the slot on — and a sweep that reaches the arm
 * only with the slot off constrains half the composition.
 */
const catalogs: fc.Arbitrary<readonly PriceableModel[]> = fc
  .constantFrom(SILENT_POOL, FULL_POOL)
  .chain((source) => subsetOf(source));

function selectionsOver(catalog: readonly PriceableModel[]): fc.Arbitrary<Selection> {
  const ids = catalog.map((model) => model.modelId);
  return fc
    .record({
      smartSlot: fc.boolean(),
      ghost: inPercent(12),
      pin: fc.constantFrom(...PINS),
      webSearch: inPercent(30),
    })
    .chain(({ smartSlot, ghost, pin, webSearch }) =>
      subsetOf(ids, { minLength: smartSlot ? 0 : 1, maxLength: Math.min(3, ids.length) }).map(
        (chosen) => {
          const models = ghost ? [...chosen, GHOST_ID] : chosen;
          const [first, ...rest] = models;
          const answerSources: AnswerSources =
            smartSlot || first === undefined
              ? { models, smartSlot: true }
              : { models: [first, ...rest], smartSlot: false };
          return {
            answerSources,
            // The arm lives in the token core. A per-unit modality refuses
            // before any entry exists, so it carries no candidate row and no
            // activation at all.
            modality: 'text',
            pinned: pin === undefined ? {} : { effort: pin },
            webSearch,
          };
        }
      )
    );
}

/**
 * Funding across the whole regime, from nothing to far past the dearest
 * arrangement these rates can build. Zero is drawn through a branch of its own
 * rather than left to a uniform draw over a nine-decade range, which reaches it
 * never. The bounds are not asserted to be right: the counters require both
 * ends to be populated, so a range that had collapsed into one regime fails
 * rather than passing quietly.
 */
const fundings: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 8, arbitrary: fc.constant(0n) },
  {
    weight: 92,
    arbitrary: fc
      .tuple(fc.bigInt({ min: 1n, max: 9n }), fc.bigInt({ min: 5n, max: 13n }))
      .map(([mantissa, decade]) => mantissa * 10n ** decade),
  }
);

/** The prompt with nothing in it — the basis the affordable pass itself uses. */
function emptyBasis(): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: 0,
    inputChars: 0,
    attachmentBytes: 0,
  };
}

/** The prompt at every field's declared maximum. */
function fullBasis(
  systemChars: number,
  instructionChars: number,
  historyChars: number,
  inputChars: number
): PromptBasis {
  return { systemChars, instructionChars, historyChars, inputChars, attachmentBytes: 0 };
}

/**
 * A prompt. The two composed endpoints are drawn through branches of their own,
 * because independent per-field draws reach neither: over fifteen hundred
 * uniform draws the all-empty prompt and the all-maximal one each came up zero
 * times. The empty one is the basis the affordable pass itself uses, so it is a
 * boundary the producer really meets.
 */
const bases: fc.Arbitrary<PromptBasis> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(emptyBasis()) },
  { weight: 3, arbitrary: fc.constant(fullBasis(4000, 2000, 160_000, 4000)) },
  {
    weight: 94,
    arbitrary: fc.record({
      systemChars: fc.integer({ min: 0, max: 4000 }),
      instructionChars: fc.integer({ min: 0, max: 2000 }),
      historyChars: fc.integer({ min: 0, max: 160_000 }),
      inputChars: fc.integer({ min: 0, max: 4000 }),
      attachmentBytes: fc.constant(0),
    }),
  }
);

const inputs: fc.Arbitrary<CoreInput> = catalogs.chain((catalog) =>
  fc.record({
    fundingNanoUsd: fundings,
    basis: bases,
    selection: selectionsOver(catalog),
    catalog: fc.constant(catalog),
    tier: fc.constantFrom(...USER_TIERS),
    nowMs: fc.constant(NOW_MS),
  })
);

function withoutPin(input: CoreInput): CoreInput {
  return { ...input, selection: { ...input.selection, pinned: {} } };
}

/**
 * The rows on the arm. The four exits from `activationFor` are separated by
 * exactly these fields: adding succeeds on the first; replacing refuses on the
 * second; the attribution is the selection's on the fourth. So a row that
 * replaces cleanly, refuses to be added, and wears the model's attribution is
 * on the third and on no other.
 */
function rowsOnArm(entries: readonly ModelEntry[]): readonly CandidateModelEntry[] {
  return entries.filter((entry): entry is CandidateModelEntry => {
    if (entry.kind !== 'candidate') return false;
    const { add, replace } = entry.activation;
    return !add.available && add.causedBy === 'model' && replace.available;
  });
}

/**
 * Every assertion one row on the arm carries.
 *
 * The first is the property itself: a row the payer is invited to swap a whole
 * selection for, on a turn that would have started and been charged for, is the
 * shape this sweep exists to rule out. The rest are the arm's own contract, and
 * the step the argument turns on — the one refusal reachable here that no
 * sibling can impose.
 */
function expectArmRow(entry: CandidateModelEntry, sendable: boolean): void {
  expect(sendable).toBe(false);
  const { add } = entry.activation;
  expect(add.available).toBe(false);
  if (add.available) return;
  expect(isSelectionCaused(add.reason)).toBe(false);
  expect(add.reason).toBe('option_not_offered');
}

/** What one draw contributed to the sweep's own coverage controls. */
interface DrawShape {
  readonly reachedArm: boolean;
  readonly reachedArmWithSlot: boolean;
  readonly reachedArmWithoutSlot: boolean;
  readonly reachedArmBesideResolvingModel: boolean;
  readonly sendsWithoutItsPin: boolean;
  readonly sendable: boolean;
  readonly unfunded: boolean;
  /** The turn's refusal, absent on a draw that sent. */
  readonly refusal: RefusalCode | undefined;
  /** The pin, kept only for the draws that reached the arm. */
  readonly pinAtArm: OptionId | undefined;
}

type CountableKey = {
  [Key in keyof DrawShape]: DrawShape[Key] extends boolean ? Key : never;
}[keyof DrawShape];

function shapeOf(input: CoreInput, optionSet: OptionSet, reachedArm: boolean): DrawShape {
  const slot = input.selection.answerSources.smartSlot;
  const pin = input.selection.pinned.effort;
  return {
    reachedArm,
    reachedArmWithSlot: reachedArm && slot,
    reachedArmWithoutSlot: reachedArm && !slot,
    reachedArmBesideResolvingModel:
      reachedArm && input.catalog.some((model) => resolvesSomeRung(model)),
    sendsWithoutItsPin: reachedArm && evaluateTurn(withoutPin(input)).optionSet.sendable,
    sendable: optionSet.sendable,
    unfunded: input.fundingNanoUsd === 0n,
    refusal: optionSet.sendable ? undefined : optionSet.refusal,
    pinAtArm: reachedArm ? pin : undefined,
  };
}

function countOf(shapes: readonly DrawShape[], key: CountableKey): number {
  return shapes.filter((shape) => shape[key]).length;
}

function setOf<Value>(
  shapes: readonly DrawShape[],
  read: (shape: DrawShape) => Value | undefined
): ReadonlySet<Value> {
  return new Set(
    shapes.flatMap((shape) => {
      const value = read(shape);
      return value === undefined ? [] : [value];
    })
  );
}

function alphabetically(left: string, right: string): number {
  return left.localeCompare(right);
}

describe('the pools the sweep draws from', () => {
  it('resolves no rung on any member of the silent pool', () => {
    expect(
      SILENT_POOL.filter((model) => resolvesSomeRung(model)).map((model) => model.modelId)
    ).toEqual([]);
  });

  it('resolves some rung on every member of the laddered pool', () => {
    expect(
      LADDERED_POOL.filter((model) => !resolvesSomeRung(model)).map((model) => model.modelId)
    ).toEqual([]);
  });
});

describe('a model-caused add refusal never appears on a sendable turn', () => {
  it('holds over 1500 generated catalogue, selection, pin, funding draws', () => {
    const shapes: DrawShape[] = [];

    fc.assert(
      fc.property(inputs, (input) => {
        const { optionSet } = evaluateTurn(input);
        const onArm = rowsOnArm(optionSet.all);
        for (const entry of onArm) expectArmRow(entry, optionSet.sendable);
        shapes.push(shapeOf(input, optionSet, onArm.length > 0));
      })
    );

    const pinsAtArm = setOf(shapes, (shape) => shape.pinAtArm);
    const refusalsSeen = setOf(shapes, (shape) => shape.refusal);
    const refusalsAtArm = setOf(
      shapes.filter((shape) => shape.reachedArm),
      (shape) => shape.refusal
    );

    // A sweep that never reached the arm, or never sent, satisfies the property
    // while constraining nothing.
    expect(countOf(shapes, 'reachedArm')).toBeGreaterThan(80);
    expect(countOf(shapes, 'sendable')).toBeGreaterThan(60);
    // Both halves of the composition: the slot decides which models are answer
    // sources, and membership of that set is what the whole argument turns on.
    expect(countOf(shapes, 'reachedArmWithSlot')).toBeGreaterThan(40);
    expect(countOf(shapes, 'reachedArmWithoutSlot')).toBeGreaterThan(30);
    // A catalogue carrying a model the pin resolves on, which the selection
    // kept out of the answer sources: the arm is not confined to catalogues
    // that resolve nothing anywhere.
    expect(countOf(shapes, 'reachedArmBesideResolvingModel')).toBeGreaterThan(8);
    // The sharp control: these turns were refused BY THE PIN. Without it the
    // same funding, tier, prompt and catalogue send, so the property is not
    // being satisfied by draws that were broke anyway.
    expect(countOf(shapes, 'sendsWithoutItsPin')).toBeGreaterThan(40);
    // Both funding regimes are drawn, so the range is not one regime.
    expect(countOf(shapes, 'unfunded')).toBeGreaterThan(40);
    // EVERY rung of the declared domain reaches the arm, so the arm is not a
    // property of one corner.
    expect([...pinsAtArm].toSorted(alphabetically)).toEqual(
      [...EFFORT_OPTION_IDS].toSorted(alphabetically)
    );
    // More than one reduction at the arm: a TIER block beside the arm's own
    // code. Those are the only two `siblingBlock` can produce here — it returns
    // `option_not_offered` before it measures the answer floor against a
    // ceiling, so no ceiling-axis code reaches a draw whose every answer source
    // resolves nothing, and it reads `tierAxisBlock` first, so where a tier fact
    // holds that is the block instead. A turn refused from outside
    // `siblingBlock` — a draw nothing priceable backs — also satisfies this, so
    // what it pins is the sibling blocks and nothing wider.
    expect(refusalsAtArm.size).toBeGreaterThan(1);
    // And the draws reach EVERY refusal the token core can produce, which is
    // what says the pool's rates, caps, context lengths and release dates were
    // chosen to span the reason space rather than to be convenient. The one
    // code absent is the media early return, which refuses before an entry —
    // and so before an activation — exists at all.
    expect([...refusalsSeen].toSorted(alphabetically)).toEqual(
      REFUSAL_CODES.filter((code) => code !== 'modality_not_priceable').toSorted(alphabetically)
    );
  });
});
