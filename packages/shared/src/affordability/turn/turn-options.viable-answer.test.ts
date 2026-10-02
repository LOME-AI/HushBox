/**
 * The offerability invariant, closed against a PRODUCED option set:
 *
 *     offered  ⟹  the rung leaves at least MINIMUM_OUTPUT_TOKENS of answer
 *                 beside the thinking budget it reserves
 *
 * One direction, and only one. Offering a rung is a CONJUNCTION — the tier axis
 * first, then whether the rung resolves on the model at all, then
 * `B(m, e) + MINIMUM_OUTPUT_TOKENS ≤ ceiling(m)` across EVERY sibling of the
 * arrangement — so a rung whose own budget fits can still be withheld because a
 * sibling starves. The converse is therefore false, and nothing here claims it.
 * The forward direction is the one the money argument needs: while a rung can
 * still be chosen, the answer share `ceiling − B` cannot fall below the minimum,
 * which is what makes "the payer who pins a rung gives up answer tokens" bounded
 * rather than open-ended — the tokens go to thinking they asked for, and the
 * answer stops at a floor rather than at zero.
 *
 * The pins run over `getTurnOptions`' own rows and the partition the producer
 * would apply, not over the predicate restated — a rung enabled by one rule and
 * split by another is exactly the disagreement worth catching. Both halves of
 * the menu are graded: a candidate row's own per-rung list, and the turn-level
 * union a payer sees once models are pinned and no slot is open.
 *
 * A control shows what a menu that dropped the minimum-answer term from that
 * rule would offer on these very fixtures, so the pins constrain something.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { dimensionSupportFor, partitionCeiling, resolveOption } from '../dimensions/derive.ts';
import { EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { reasoningBudgetTokens } from './turn-arithmetic.ts';
import { getTurnOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type {
  AnswerSources,
  ModelEntry,
  NonEmpty,
  OptionAvailability,
  OptionSet,
  PromptBasis,
  Selection,
} from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/**
 * Ladders wide enough that the rungs really compete for the ceiling: a roomy
 * model whose whole ladder fits, a mid one where the upper rungs stop fitting as
 * the balance drops, and a tight-context one where only the bottom of the ladder
 * ever leaves an answer.
 */
const CATALOG: readonly PriceableModel[] = [
  {
    modelId: modelId('vendor/roomy'),
    pricing: tokenPricingFixture({ input: nanoUSD(60n), output: nanoUSD(150n) }),
    contextLength: 200_000,
    providerCap: 100_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: null },
  },
  {
    modelId: modelId('vendor/mid'),
    pricing: tokenPricingFixture({ input: nanoUSD(1200n), output: nanoUSD(3600n) }),
    contextLength: 64_000,
    providerCap: 40_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('vendor/tight'),
    pricing: tokenPricingFixture({ input: nanoUSD(400n), output: nanoUSD(900n) }),
    contextLength: 12_000,
    providerCap: 6000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: null },
  },
];

const EFFORT_PINS = [undefined, 'lite', 'low', 'medium', 'high', 'max'] as const;

/**
 * What the payer selected as answer sources. The SLOT draw leaves the pool open,
 * so every catalog model is a candidate row publishing its own per-rung list;
 * the PINNED draw closes the slot and names siblings, which is the shape that
 * puts the turn-level union in front of the payer instead.
 */
type Shape = 'slot' | 'pinned';

/** One turn's worth of inputs, drawn independently of the shape it is read at. */
interface Draw {
  readonly spendable: bigint;
  readonly held: bigint;
  readonly basis: PromptBasis;
  readonly pin: (typeof EFFORT_PINS)[number];
  readonly sibling: ModelId;
  readonly webSearch: boolean;
}

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
  { weight: 3, arbitrary: fc.constant(fullBasis(4000, 2000, 40_000, 4000)) },
  {
    weight: 94,
    arbitrary: fc.record({
      systemChars: fc.integer({ min: 0, max: 4000 }),
      instructionChars: fc.integer({ min: 0, max: 2000 }),
      historyChars: fc.integer({ min: 0, max: 40_000 }),
      inputChars: fc.integer({ min: 0, max: 4000 }),
      attachmentBytes: fc.constant(0),
    }),
  }
);

const millicents = (min: number, max: number): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: BigInt(min), max: BigInt(max) }).map((value) => value * 1_000_000n);

const draws: fc.Arbitrary<Draw> = fc.record({
  spendable: millicents(0, 600),
  held: millicents(0, 200),
  basis: bases,
  pin: fc.constantFrom(...EFFORT_PINS),
  sibling: fc.constantFrom(...CATALOG.map((model) => model.modelId)),
  webSearch: fc.boolean(),
});

function answerSourcesOf(draw: Draw, shape: Shape): AnswerSources {
  if (shape === 'slot') return { models: [], smartSlot: true };
  const siblings: NonEmpty<ModelId> = [draw.sibling];
  return { models: siblings, smartSlot: false };
}

function selectionOf(draw: Draw, shape: Shape): Selection {
  return {
    answerSources: answerSourcesOf(draw, shape),
    modality: 'text',
    pinned: draw.pin === undefined ? {} : { effort: draw.pin },
    webSearch: draw.webSearch,
  };
}

/** Which of the menu's two halves a rung came off. */
type Source = 'candidate row' | 'turn union';

/** One rung as one model would run it: its budget, and what the producer leaves. */
interface Rung {
  readonly source: Source;
  readonly modelId: string;
  readonly optionId: OptionId;
  readonly available: boolean;
  readonly ceilingTokens: number;
  /** `B(m, e)` as the registry states it, before the partition's clamp. */
  readonly requiredTokens: number;
  readonly reservedTokens: number;
  readonly answerTokens: number;
}

const BY_ID = new Map(CATALOG.map((model) => [String(model.modelId), model]));

/**
 * One rung as one model would run it. The option is RESOLVED against that
 * model's own support first, because a union rung names a level some sibling may
 * not offer and the production gate resolves downward before it reserves
 * anything. A rung that resolves nowhere on the model reserves nothing — the
 * sibling runs wire-silent — which is the same reading the gate takes.
 */
function rungOf(
  source: Source,
  model: PriceableModel,
  ceilingTokens: number,
  option: OptionAvailability
): Rung {
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  const resolved = resolveOption(EFFORT_DIMENSION, support, option.optionId);
  const requiredTokens = resolved === undefined ? 0 : reasoningBudgetTokens(model, resolved);
  const split =
    resolved === undefined
      ? { reservedTokens: 0, answerTokens: ceilingTokens }
      : partitionCeiling(EFFORT_DIMENSION, model, support, { ceilingTokens, chosen: resolved });
  return {
    source,
    modelId: String(model.modelId),
    optionId: option.optionId,
    available: option.availability.available,
    ceilingTokens,
    requiredTokens,
    reservedTokens: split.reservedTokens,
    answerTokens: split.answerTokens,
  };
}

/**
 * The ceiling a rung runs at on one row: its own budget solve's when the row
 * publishes one for that rung, which it does for every rung the turn can run. A
 * searching turn prices each rung at its own tool loop, so that is the ceiling
 * the rung's thinking budget and answer share; a rung the row publishes nothing
 * for is graded at the row's own ceiling.
 */
function rungCeilingOf(entry: ModelEntry, optionId: OptionId): number {
  return (
    entry.rungCeilings.find((rung) => rung.effort === optionId)?.ceilingTokens ??
    entry.ceilingTokens
  );
}

/** A candidate row's own per-rung list, each rung graded at the ceiling it runs at. */
function candidateRungsOf(entry: ModelEntry): readonly Rung[] {
  if (entry.kind !== 'candidate') return [];
  const model = BY_ID.get(String(entry.modelId));
  if (model === undefined) return [];
  return entry.dimensions.flatMap((dimension) =>
    dimension.options.map((option) =>
      rungOf('candidate row', model, rungCeilingOf(entry, option.optionId), option)
    )
  );
}

/**
 * The turn-level union, graded against every sibling it commits. Read only off a
 * PINNED draw: with the slot closed the turn is one arrangement, so an offered
 * union rung is a promise about each of these rows. With a slot open the union
 * is an OR over the arrangements the classifier could pick, and grading every
 * candidate row against it would be reading a different claim.
 */
function unionRungsOf(set: OptionSet): readonly Rung[] {
  const siblings = set.all.flatMap((entry) => {
    const model = entry.kind === 'pinned' ? BY_ID.get(String(entry.modelId)) : undefined;
    return model === undefined ? [] : [{ model, entry }];
  });
  return set.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) =>
      siblings.map((sibling) =>
        rungOf('turn union', sibling.model, rungCeilingOf(sibling.entry, option.optionId), option)
      )
    )
  );
}

/** Every rung of every produced set over one sweep of the fixture space. */
function sweep(over: readonly Draw[], shape: Shape): readonly Rung[] {
  const rungs: Rung[] = [];
  for (const draw of over) {
    const options = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(draw.spendable),
        heldNanoUsd: nanoUSD(draw.held),
        payerTier: 'paid',
        payer: 'self',
      },
      draw.basis,
      selectionOf(draw, shape),
      { models: CATALOG, nowMs: NOW_MS }
    );
    for (const set of [options.admissible, options.affordable]) {
      for (const entry of set.all) rungs.push(...candidateRungsOf(entry));
      if (shape === 'pinned') rungs.push(...unionRungsOf(set));
    }
  }
  return rungs;
}

/**
 * Six hundred draws, split so each shape gets three hundred of its own. Drawn
 * as one sample and halved rather than sampled twice: the library re-seeds from
 * the configured seed on every call, so two samples of one generator are the
 * same six hundred values read twice.
 */
const DRAWS = fc.sample(draws, 600);

/**
 * The slot draws grade every catalog model as a candidate on its OWN
 * arrangement — one model, no siblings — which is the population the control
 * below needs: there, a withheld rung was withheld by this model's own budget.
 * The pinned draws add the sibling structure and the turn-level union.
 */
const SOLO_RUNGS = sweep(DRAWS.slice(0, 300), 'slot');
const RUNGS = [...SOLO_RUNGS, ...sweep(DRAWS.slice(300), 'pinned')];
const OFFERED = RUNGS.filter((rung) => rung.available);
const CANDIDATE_RUNGS = RUNGS.filter((rung) => rung.source === 'candidate row');
const UNION_RUNGS = RUNGS.filter((rung) => rung.source === 'turn union');

describe('an offerable rung leaves a viable answer', () => {
  it('never presents one whose answer share is below the minimum', () => {
    const starved = OFFERED.filter((rung) => rung.answerTokens < MINIMUM_OUTPUT_TOKENS).map(
      (rung) =>
        `${rung.modelId} ${rung.optionId} ceiling=${String(rung.ceilingTokens)} answer=${String(rung.answerTokens)}`
    );
    expect(starved).toEqual([]);
  });

  it('reserves exactly the budget the rung asked for, never a clamped part of it', () => {
    // The other half of the bound: the answer share is short by the pinned
    // budget and by NOTHING ELSE, which is what makes the loss the payer's own
    // choice rather than a cost the shape imposed. Asserted against the budget
    // the registry states rather than against the partition's own output — the
    // producer returns the answer share AS the difference, so comparing the two
    // halves of one subtraction to their own total is arithmetic that cannot
    // come out any other way.
    const clamped = OFFERED.filter((rung) => rung.reservedTokens !== rung.requiredTokens);
    expect(clamped).toEqual([]);
  });

  it('clamps a withheld rung, so reserved-equals-budget is a claim not an identity', () => {
    // The clamp is real and the sweep reaches it: some rung the menu withholds
    // asks for more than its whole ceiling and is cut down to it. That is the
    // population reserved-equals-budget would fail on, and it is exactly the
    // population the enablement rule keeps out of the payer's reach.
    const cut = RUNGS.filter((rung) => rung.reservedTokens < rung.requiredTokens);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((rung) => !rung.available)).toBe(true);
  });

  it('binds a sweep that offers rungs, withholds rungs, and covers both halves', () => {
    // Neither half may be empty: an all-enabled sweep would satisfy the pin
    // without the predicate doing anything, an all-disabled one vacuously. And
    // the turn-level union is graded too, so the file's claim about "the menu"
    // covers the menu a payer sees with a model pinned.
    expect(OFFERED.length).toBeGreaterThan(0);
    expect(RUNGS.length).toBeGreaterThan(OFFERED.length);
    expect(CANDIDATE_RUNGS.length).toBeGreaterThan(0);
    expect(UNION_RUNGS.length).toBeGreaterThan(0);
    expect(UNION_RUNGS.filter((rung) => rung.available).length).toBeGreaterThan(0);
  });

  it('reaches the floor it claims, so the bound is tight rather than generous', () => {
    // A sweep whose smallest answer share sat far above the minimum would pass
    // the pin without ever approaching it. Some offered rung must sit within one
    // minimum answer of the floor.
    const smallest = Math.min(...OFFERED.map((rung) => rung.answerTokens));
    expect(smallest).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    expect(smallest).toBeLessThan(2 * MINIMUM_OUTPUT_TOKENS);
  });

  it('control: a menu enabling rungs on the thinking budget alone starves answers', () => {
    // The mutant is the enablement rule MINUS the minimum-answer term: `B(m, e)
    // ≤ ceiling(m)` on the budget the registry states, not on the partition's
    // clamped `reservedTokens` — which is `min(B, ceiling)` and so satisfies
    // that comparison for every rung ever produced. Filtering on the clamped
    // figure builds "enable everything" and measures nothing.
    //
    // Read over the solo arrangements, where a row's verdict rests on that one
    // model, so a rung the mutant gains is a rung THIS term withheld rather than
    // one a different sibling starved — availability is a conjunction over the
    // siblings, and a mutant read across them would attribute their refusals to
    // this term.
    const offered = SOLO_RUNGS.filter((rung) => rung.available);
    const mutantOffered = SOLO_RUNGS.filter((rung) => rung.requiredTokens <= rung.ceilingTokens);
    const gained = mutantOffered.filter((rung) => !rung.available);
    expect(mutantOffered.length).toBeGreaterThan(offered.length);
    expect(mutantOffered.length).toBeLessThan(SOLO_RUNGS.length);
    // Every rung it gains is starved — the term it dropped is the only thing
    // that was holding them back — and they are not an artifact of unfunded
    // rows: some sit on a real ceiling the budget genuinely fits inside.
    const starved = gained.filter((rung) => rung.answerTokens < MINIMUM_OUTPUT_TOKENS);
    expect(starved.length).toBe(gained.length);
    expect(gained.filter((rung) => rung.ceilingTokens > 0).length).toBeGreaterThan(0);
  });
});
