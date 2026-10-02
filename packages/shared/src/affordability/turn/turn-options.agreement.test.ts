/**
 * The four readings of "what is presented or possible" agree pairwise.
 *
 * The producer publishes four of them — a row's availability, the turn-level
 * dimension union, the send gate, and the domain the hold's `MAX` is taken over
 * — and each one is a decision: what the classifier may pick, what the user may
 * pick, what the server admits, what money is reserved. Two of them computed from
 * different derivations disagree silently and repeatedly, and each disagreement is
 * a money or a menu defect, so the agreements are asserted as properties over
 * generated turns rather than spot-checked on a fixture. The pairs, named:
 *
 * - **union ↔ send gate** — a rung the menu enables is a rung a pin of that rung
 *   can send (§Reasoning Effort 3: "the same predicate the server admits on, so
 *   a menu can never enable a level the server refuses"). Universal in that
 *   direction, and a strict biconditional carrying the REASON on the shape where
 *   the classifier reserve cannot move between the two calls — see
 *   {@link reserveIsPinInvariant}.
 * - **send gate ↔ hold** — a hold exists exactly when the turn can start.
 * - **rows ↔ send gate** — the turn sends exactly when every selected row is
 *   available and, with a smart slot, some candidate row is.
 * - **a row's rungs ↔ that row's verdict** — a rung is presented on a row iff
 *   pinning that rung leaves the row presented. The row's rungs are the ceiling a
 *   classifier answer clamps onto, so a rung above the row's own verdict at it
 *   would clamp a joint pick onto a rung the arrangement cannot honour.
 *
 * Both arms of the pair are swept, because `affordable` and `admissible` are two
 * evaluations of one core and a reading that agrees on one funding number can
 * still disagree on the other.
 *
 * Every property is measured through the producer — the same turn re-produced with
 * a rung pinned — so nothing here re-implements pricing to check pricing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EFFORT_OPTION_IDS } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { USER_TIERS } from '../money/tiers.ts';
import { getTurnOptions, smartSlotAvailability } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type {
  FundingSnapshot,
  OptionSet,
  PromptBasis,
  RefusalCode,
  Selection,
  TurnOptions,
} from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/**
 * Shapes chosen so both arms of every property below occur: a wide cap that fits
 * High's budget and a long-context rate a long history reaches, a narrow cap that fits Low's and not Mid's (the quantifier
 * fixture — one sibling honours a rung the other cannot), a mandatory-reasoning
 * model whose cheapest corner is not free, a model with no ladder at all, and a
 * dear one that starves its siblings.
 */
const CATALOG: readonly PriceableModel[] = [
  {
    modelId: modelId('v/wide'),
    pricing: tokenPricingFixture({
      input: nanoUSD(60n),
      output: nanoUSD(150n),
      tiers: [{ abovePromptTokens: 128_000, input: nanoUSD(120n), output: nanoUSD(225n) }],
    }),
    contextLength: 200_000,
    providerCap: 64_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('v/narrow'),
    pricing: tokenPricingFixture({ input: nanoUSD(200n), output: nanoUSD(500n) }),
    contextLength: 128_000,
    providerCap: 9000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('v/mandatory'),
    pricing: tokenPricingFixture({ input: nanoUSD(2500n), output: nanoUSD(9000n) }),
    contextLength: 32_000,
    providerCap: 20_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  },
  {
    modelId: modelId('v/plain'),
    pricing: tokenPricingFixture({ input: nanoUSD(800n), output: nanoUSD(1600n) }),
    contextLength: 128_000,
    providerCap: 8000,
    releasedAtMs: 0,
    reasoning: undefined,
  },
  {
    modelId: modelId('v/dear'),
    pricing: tokenPricingFixture({ input: nanoUSD(20_000n), output: nanoUSD(90_000n) }),
    contextLength: 64_000,
    providerCap: 32_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'low'] },
  },
];

const MODEL_IDS = CATALOG.map((model) => model.modelId);
const EFFORT_PINS = [undefined, 'off', 'low', 'medium', 'high'] as const;

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
  { weight: 3, arbitrary: fc.constant(fullBasis(3000, 1000, 60_000, 3000)) },
  // A history past the wide model's 128,000-token threshold, inside its window.
  {
    weight: 10,
    arbitrary: fc
      .integer({ min: 384_000, max: 540_000 })
      .map((historyChars) => fullBasis(1500, 0, historyChars, 1500)),
  },
  {
    weight: 84,
    arbitrary: fc.record({
      systemChars: fc.integer({ min: 0, max: 3000 }),
      instructionChars: fc.integer({ min: 0, max: 1000 }),
      historyChars: fc.integer({ min: 0, max: 60_000 }),
      inputChars: fc.integer({ min: 0, max: 3000 }),
      attachmentBytes: fc.constant(0),
    }),
  }
);

const selections: fc.Arbitrary<Selection> = fc
  .record({
    models: fc.subarray(MODEL_IDS).map((chosen) => chosen.slice(0, 3)),
    openSlot: fc.boolean(),
    pin: fc.constantFrom(...EFFORT_PINS),
    webSearch: fc.boolean(),
  })
  .map(({ models, openSlot, pin, webSearch }) => {
    // A turn with nothing pinned has to leave the slot open; there would be
    // nothing to answer with otherwise.
    const smartSlot = models.length === 0 ? true : openSlot;
    return {
      answerSources: smartSlot
        ? { models, smartSlot: true }
        : {
            models: [models[0] ?? MODEL_IDS[0] ?? modelId('vendor/none'), ...models.slice(1)],
            smartSlot: false,
          },
      modality: 'text',
      pinned: pin === undefined ? {} : { effort: pin },
      webSearch,
    };
  });

/** The same selection with one rung pinned — the turn the send gate would judge. */
function pinnedTo(selection: Selection, optionId: OptionId): Selection {
  return { ...selection, pinned: { ...selection.pinned, effort: optionId } };
}

/**
 * Whether the classifier reserve is the same amount on the open turn and on a
 * turn with the effort rung pinned. A reserve is bought when ANY dimension is
 * open, so pinning effort on a turn whose only open dimension IS effort drops
 * it, which raises the pinned turn's shared token count by the reserve and lets
 * a money-bound rung that the menu greyed become sendable. With a smart slot
 * over two or more candidates the model dimension keeps the reserve bought
 * either way, so the two calls price identically and the agreement is exact in
 * both directions.
 */
function reserveIsPinInvariant(selection: Selection): boolean {
  const pinnedCount = selection.answerSources.models.length;
  return selection.answerSources.smartSlot && CATALOG.length - pinnedCount >= 2;
}

/** One rung's verdict in the turn-level menu, or `undefined` when unlisted. */
function rungVerdict(set: OptionSet, optionId: OptionId): boolean | undefined {
  return set.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability.available;
}

function rungReason(set: OptionSet, optionId: OptionId): RefusalCode | undefined {
  const availability = set.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability;
  return availability?.available === false ? availability.reason : undefined;
}

function refusalOf(set: OptionSet): RefusalCode | undefined {
  return set.sendable ? undefined : set.refusal;
}

const millicents = (max: number): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 0n, max: BigInt(max) }).map((value) => value * 1_000_000n);

const fundings: fc.Arbitrary<FundingSnapshot> = fc.record({
  spendableNanoUsd: millicents(400).map((value) => nanoUSD(value)),
  heldNanoUsd: millicents(200).map((value) => nanoUSD(value)),
  payerTier: fc.constantFrom(...USER_TIERS),
  payer: fc.constant('self'),
});

/** The two arms, so every property below is asserted on both evaluations. */
function armsOf(pair: TurnOptions): readonly (readonly [string, OptionSet])[] {
  return [
    ['affordable', pair.affordable],
    ['admissible', pair.admissible],
  ];
}

/** One arm of one draw, and the send gate to compare it against. */
interface Pairing {
  readonly arm: string;
  readonly set: OptionSet;
  /** The same turn with one rung pinned, on the same arm. */
  readonly gateFor: (optionId: OptionId) => OptionSet;
  /** Whether the two calls price identically — see {@link reserveIsPinInvariant}. */
  readonly strict: boolean;
}

/** What one draw contributed, so a sweep that proved nothing fails its own controls. */
interface Tally {
  enabled: number;
  greyed: number;
  reasonsChecked: number;
  rungsChecked: number;
  strictDraws: number;
  unsendable: number;
  slotBesidePinned: number;
  /** Arm-draws where the rows ↔ gate pair is not satisfied by construction. */
  rowsGradedAgainstGate: number;
}

function emptyTally(): Tally {
  return {
    enabled: 0,
    greyed: 0,
    reasonsChecked: 0,
    rungsChecked: 0,
    strictDraws: 0,
    unsendable: 0,
    slotBesidePinned: 0,
    rowsGradedAgainstGate: 0,
  };
}

/**
 * The union ↔ send-gate pair, on one arm. Every listed rung is re-produced with
 * that rung pinned and the arm's own verdict compared: enabling a rung the gate
 * refuses is the defect §Reasoning Effort 3 forbids outright, and on the
 * reserve-invariant shape the greyed rungs must carry the very reason the gate
 * would give.
 */
function expectMenuMatchesGate(pairing: Pairing, tally: Tally): void {
  const { arm, set, gateFor, strict } = pairing;
  for (const optionId of EFFORT_OPTION_IDS) {
    const enabled = rungVerdict(set, optionId);
    if (enabled === undefined) continue;
    const gate = gateFor(optionId);
    if (enabled) {
      expect(`${arm}:${optionId}:${String(gate.sendable)}`).toBe(`${arm}:${optionId}:true`);
      tally.enabled += 1;
      continue;
    }
    tally.greyed += 1;
    if (!strict) continue;
    expect(`${arm}:${optionId}:${String(gate.sendable)}`).toBe(`${arm}:${optionId}:false`);
    expect(`${arm}:${optionId}:${String(rungReason(set, optionId))}`).toBe(
      `${arm}:${optionId}:${String(refusalOf(gate))}`
    );
    tally.reasonsChecked += 1;
  }
}

/**
 * The pair inside one row: a rung is presented on a row iff pinning that rung
 * leaves the row presented. Both readings are decisions — the row's verdict is
 * what the classifier may pick, its rungs are the per-candidate ceiling a
 * classifier answer clamps onto (§Story 2.2, §Reasoning Effort 8) — so a rung
 * standing above the row's own verdict at that rung would clamp a joint pick onto
 * a rung the arrangement cannot honour.
 *
 * Scoped to the candidate rows because they are the rows that carry rungs at all:
 * a pinned sibling is already chosen, so nothing picks a rung on it and the type
 * publishes none.
 */
function expectRungsMatchRows(pairing: Pairing, tally: Tally): void {
  const { arm, set, gateFor } = pairing;
  for (const entry of set.all) {
    if (entry.kind !== 'candidate') continue;
    for (const option of entry.dimensions.flatMap((dimension) => dimension.options)) {
      const rowUnderPin = gateFor(option.optionId).all.find(
        (candidate) => candidate.modelId === entry.modelId
      );
      expect(
        `${arm}:${entry.modelId}:${option.optionId}:${String(option.availability.available)}`
      ).toBe(
        `${arm}:${entry.modelId}:${option.optionId}:${String(rowUnderPin?.availability.available)}`
      );
      tally.rungsChecked += 1;
    }
  }
}

/**
 * The rows ↔ send-gate pair: what sends is what the rows say can answer.
 *
 * Membership of `all` is deliberately WIDER than what the turn can run, in two
 * ways the type states outright — an unavailable row stays so its greying can be
 * explained, and a high-cost outlier stays marked available because pinning it
 * is a selection the payer can still make even though the slot may not resolve
 * to it. So "some candidate row in `all` is available" was never the question
 * the gate answers, and a reading that asks it there disagrees with the gate on
 * every turn whose only available candidate is an outlier.
 *
 * The slot half is therefore asked through {@link smartSlotAvailability}, the
 * producer's own published answer to whether the slot can be filled — the same
 * predicate the server's candidate menu refuses on. Recomputing which models the
 * classifier may not pick would be a second copy of a rule the producer owns.
 *
 * That query answers an unsendable set with the turn's own refusal, so on a
 * smart-slot draw the unsendable arm is satisfied by construction and the pair
 * constrains nothing there. The draws it does constrain — every closed-slot
 * draw, on both arms, and every sendable smart-slot draw — are counted, so a
 * sweep that only ever reached the construction-satisfied cell fails its own
 * control.
 */
function expectRowsMatchGate(
  arm: string,
  set: OptionSet,
  selection: Selection,
  tally: Tally
): void {
  const selectedIds = selection.answerSources.models;
  const available = (modelId: string): boolean =>
    set.all.some((entry) => entry.modelId === modelId && entry.availability.available);
  const everySelected = selectedIds.every((modelId) => available(modelId));
  const slotOpen = selection.answerSources.smartSlot;
  const slotFillable = !slotOpen || smartSlotAvailability(set).available;
  const fromRows = everySelected && slotFillable;
  expect(`${arm}:${String(set.sendable)}`).toBe(`${arm}:${String(fromRows)}`);
  if (!slotOpen || set.sendable) tally.rowsGradedAgainstGate += 1;
}

/** One draw: produce the turn, then hold every pair against the same funding. */
function checkDraw(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: Selection,
  tally: Tally
): void {
  const pair = getTurnOptions(funding, basis, selection, { models: CATALOG, nowMs: NOW_MS });
  const strict = reserveIsPinInvariant(selection);
  if (strict) tally.strictDraws += 1;
  if (!pair.admissible.sendable) tally.unsendable += 1;
  if (selection.answerSources.smartSlot && selection.answerSources.models.length > 0) {
    tally.slotBesidePinned += 1;
  }

  // send gate ↔ hold: a hold is a value only a startable turn has.
  expect(pair.holdNanoUsd !== undefined).toBe(pair.admissible.sendable);

  const gates = new Map<OptionId, TurnOptions>();
  const gateArms = (optionId: OptionId): TurnOptions => {
    const cached = gates.get(optionId);
    if (cached !== undefined) return cached;
    const produced = getTurnOptions(funding, basis, pinnedTo(selection, optionId), {
      models: CATALOG,
      nowMs: NOW_MS,
    });
    gates.set(optionId, produced);
    return produced;
  };
  for (const [arm, set] of armsOf(pair)) {
    const gateFor = (optionId: OptionId): OptionSet => {
      const produced = gateArms(optionId);
      return arm === 'affordable' ? produced.affordable : produced.admissible;
    };
    const pairing: Pairing = { arm, set, gateFor, strict };
    expectRowsMatchGate(arm, set, selection, tally);
    expectMenuMatchesGate(pairing, tally);
    // A row's rungs are its own verdict at those rungs, which is exact only where
    // the two calls price identically.
    if (strict) expectRungsMatchRows(pairing, tally);
  }
}

describe('the four readings agree pairwise', () => {
  it('holds over 200 generated funding/prompt/selection triples', () => {
    const tally = emptyTally();
    // Two hundred, stated rather than inherited: each draw re-produces the turn
    // once per rung of the effort domain, per arm, so the count is what decides
    // whether this file runs in a second or in half a minute.
    fc.assert(
      fc.property(fundings, bases, selections, (funding, basis, selection) => {
        checkDraw(funding, basis, selection, tally);
      }),
      { numRuns: 200 }
    );
    // A sweep that never enabled a rung, never greyed one, never reached the
    // strict shape, or never saw an unsendable turn satisfies every property
    // above while constraining nothing.
    expect(tally.enabled).toBeGreaterThan(100);
    expect(tally.greyed).toBeGreaterThan(100);
    expect(tally.reasonsChecked).toBeGreaterThan(50);
    expect(tally.rungsChecked).toBeGreaterThan(500);
    expect(tally.strictDraws).toBeGreaterThan(20);
    expect(tally.unsendable).toBeGreaterThan(20);
    expect(tally.slotBesidePinned).toBeGreaterThan(20);
    // And the rows ↔ gate pair graded real draws rather than only the cell the
    // slot query answers from the turn's own refusal.
    expect(tally.rowsGradedAgainstGate).toBeGreaterThan(50);
  });
});
