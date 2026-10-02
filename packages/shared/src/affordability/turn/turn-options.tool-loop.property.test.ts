/**
 * The invariants of a searching turn under an open effort axis, over generated
 * turns. Every rung the classifier may decide is sized by its own budget solve,
 * so:
 *
 * - an Auto turn that decides rung `d` gives each answer what the same turn
 *   pinned at `d` gives it, at the funding left after the classifier reserve;
 * - the Auto hold is that reserve plus the largest of those pinned holds;
 * - a rising balance never shrinks a rung's ceiling, the available rungs or the
 *   Smart Model candidate set;
 * - the available rungs form a prefix of the ladder;
 * - `admissible ⊆ affordable` holds for ceilings and per option;
 * - on a Smart Model slot turn, every classifier answer decides a rung the turn
 *   presented and the bound candidate answers at.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EFFORT_OPTION_IDS } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { REASONING_EFFORT_LABELS } from '../reasoning-effort.ts';
import { resolveClassifierAnswer } from '../smart-model/answer-resolution.ts';
import { evaluateTurn } from './turn-core.ts';
import { getTurnOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { candidateAnsweringAt } from '../../workflow/workflow.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { UserTier } from '../money/tiers.ts';
import type { ResolvedReasoningEffort } from '../reasoning-effort.ts';
import type { CoreResult } from './turn-core.ts';
import type { ModelEntry, OptionSet, PromptBasis, Selection } from './turn-types.ts';

const NOW_MS = TEST_DAY_START;

function row(
  id: string,
  rates: readonly [bigint, bigint],
  bounds: readonly [number, number],
  reasoning?: PriceableModel['reasoning']
): PriceableModel {
  return {
    modelId: modelId(id),
    pricing: tokenPricingFixture({ input: nanoUSD(rates[0]), output: nanoUSD(rates[1]) }),
    contextLength: bounds[0],
    providerCap: bounds[1],
    releasedAtMs: 0,
    reasoning,
  };
}

/** Rates are stored billable rates, fee included. */
const CATALOG: readonly PriceableModel[] = [
  row('vendor/sonnet', [3450n, 17_250n], [1_000_000, 128_000], {
    supportedEfforts: ['max', 'high', 'medium', 'low'],
  }),
  row('vendor/open', [600n, 2400n], [200_000, 64_000], { supportedEfforts: null }),
  row('vendor/engine', [52n, 161n], [131_072, 16_384], {
    supportedEfforts: ['high', 'medium', 'low'],
    mandatory: true,
  }),
  row('vendor/mandatory', [1000n, 5000n], [200_000, 64_000], {
    supportedEfforts: ['high', 'medium', 'low'],
    mandatory: true,
  }),
  row('vendor/ladderless', [200n, 800n], [128_000, 16_000]),
];

const IDS = CATALOG.map((model) => model.modelId);

const DOLLAR = 1_000_000_000n;

/** A prompt: history up to 200,000 characters and a new message up to 4,000. */
const bases: fc.Arbitrary<PromptBasis> = fc.record({
  systemChars: fc.constant(0),
  instructionChars: fc.constant(0),
  historyChars: fc.integer({ min: 0, max: 200_000 }),
  inputChars: fc.integer({ min: 0, max: 4000 }),
  attachmentBytes: fc.constant(0),
});

const tiers: fc.Arbitrary<UserTier> = fc.constantFrom('paid', 'free');

/**
 * A spendable balance from nothing to $40, in millicent steps, half of them under
 * $2, where rungs open one at a time and a menu marks a single rung available.
 */
const balances: fc.Arbitrary<bigint> = fc
  .oneof(fc.bigInt({ min: 0n, max: 40_000n }), fc.bigInt({ min: 0n, max: 2000n }))
  .map((millicents) => millicents * 1_000_000n);

interface NonSlotTurn {
  readonly models: readonly [string, ...string[]];
  readonly basis: PromptBasis;
  readonly tier: UserTier;
  readonly spendable: bigint;
}

/** Generator `searchingAutoTurns`: one or two pinned models, searching, effort open. */
const searchingAutoTurns: fc.Arbitrary<NonSlotTurn> = fc.record({
  models: fc
    .uniqueArray(fc.constantFrom(...IDS), { minLength: 1, maxLength: 2 })
    .map((ids): readonly [string, ...string[]] => [ids[0] ?? 'vendor/sonnet', ...ids.slice(1)]),
  basis: bases,
  tier: tiers,
  spendable: balances,
});

interface AnyTurn {
  readonly selection: (pin?: OptionId) => Selection;
  readonly basis: PromptBasis;
  readonly tier: UserTier;
  readonly spendable: bigint;
}

interface SlotTurn {
  readonly pinned: readonly string[];
  readonly basis: PromptBasis;
  readonly tier: UserTier;
  readonly spendable: bigint;
}

/**
 * Generator `searchingSlotTurns`: Smart Model slot turns, searching with effort
 * open, with none or one model pinned beside the slot.
 */
const searchingSlotTurns: fc.Arbitrary<SlotTurn> = fc
  .record({
    pinned: fc.option(fc.constantFrom(...IDS), { nil: undefined }),
    basis: bases,
    tier: tiers,
    spendable: balances,
  })
  .map(({ pinned, basis, tier, spendable }) => ({
    pinned: pinned === undefined ? [] : [pinned],
    basis,
    tier,
    spendable,
  }));

/**
 * Generator `searchingAutoOrSlotTurns`: the non-slot turns of `searchingAutoTurns`,
 * and the slot turns of `searchingSlotTurns`.
 */
const searchingAutoOrSlotTurns: fc.Arbitrary<AnyTurn> = fc.oneof(
  searchingAutoTurns.map(
    ({ models, basis, tier, spendable }): AnyTurn => ({
      selection: (pin) => nonSlotSelection(models, pin),
      basis,
      tier,
      spendable,
    })
  ),
  searchingSlotTurns.map(
    ({ pinned, basis, tier, spendable }): AnyTurn => ({
      selection: (pin) => slotSelection(pinned, pin),
      basis,
      tier,
      spendable,
    })
  )
);

function slotSelection(models: readonly string[], pin?: OptionId): Selection {
  return {
    answerSources: { models: models.map((id) => modelId(id)), smartSlot: true },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch: true,
  };
}

function nonSlotSelection(models: readonly string[], pin?: OptionId): Selection {
  const [first = 'vendor/sonnet', ...rest] = models;
  return {
    answerSources: { models: [modelId(first), ...rest.map((id) => modelId(id))], smartSlot: false },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch: true,
  };
}

function evaluate(
  selection: Selection,
  funding: bigint,
  basis: PromptBasis,
  tier: UserTier
): CoreResult {
  return evaluateTurn({
    fundingNanoUsd: funding,
    basis,
    selection,
    catalog: CATALOG,
    tier,
    nowMs: NOW_MS,
  });
}

/** The classifier reserve the hold carries, read off its own line item. */
function reserveOf(result: CoreResult): bigint {
  return result.lineItems
    .filter((item) => item.label === 'classifier-tokens')
    .reduce((total, item) => total + (item.fixedNano ?? 0n), 0n);
}

/** The classifier reserve the solves deducted: what the hold carries and what it set aside. */
function deductedOf(result: CoreResult): bigint {
  return reserveOf(result) + result.setAsideNanoUsd;
}

function availableRungs(set: OptionSet): readonly string[] {
  return set.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

function entryOf(set: OptionSet, id: string): ModelEntry | undefined {
  return set.all.find((entry) => entry.modelId === id);
}

describe('an Auto turn at a rung is the same turn pinned at that rung', () => {
  it('gives each answer the ceiling the pin at the decided rung gives it, less the reserve', () => {
    let compared = 0;
    let candidatesCompared = 0;
    fc.assert(
      fc.property(searchingAutoOrSlotTurns, ({ selection, basis, tier, spendable }) => {
        const auto = evaluate(selection(), spendable, basis, tier);
        if (!auto.optionSet.sendable) return;
        for (const effort of availableRungs(auto.optionSet)) {
          // The pin still buys what an open model axis buys, so only the reserve
          // the open effort axis adds is taken off the pinned turn's funding.
          const pinnedReserve = deductedOf(evaluate(selection(effort), spendable, basis, tier));
          const pinned = evaluate(
            selection(effort),
            spendable - deductedOf(auto) + pinnedReserve,
            basis,
            tier
          );
          expect(pinned.optionSet.toolLoopEffort).toBe(effort);
          for (const entry of auto.optionSet.all) {
            const decided = entry.rungCeilings.find((rung) => rung.effort === effort);
            if (decided === undefined) continue;
            expect(decided.ceilingTokens).toBe(
              entryOf(pinned.optionSet, entry.modelId)?.ceilingTokens
            );
            compared += 1;
            if (entry.kind === 'candidate') candidatesCompared += 1;
          }
        }
      }),
      { numRuns: 300 }
    );
    expect(compared).toBeGreaterThan(100);
    expect(candidatesCompared).toBeGreaterThan(50);
  });

  it('holds the largest pinned hold over the available rungs, plus the reserve of a call it still buys', () => {
    let compared = 0;
    let settled = 0;
    fc.assert(
      fc.property(searchingAutoTurns, ({ models, basis, tier, spendable }) => {
        const auto = evaluate(nonSlotSelection(models), spendable, basis, tier);
        const available = availableRungs(auto.optionSet);
        // With no ladder there is no rung to decide, and the hold is the ceiling loop's.
        if (auto.totalNanoUsd === undefined || available.length === 0) return;
        const deducted = deductedOf(auto);
        let largest = 0n;
        for (const effort of available) {
          const pinned = evaluate(
            nonSlotSelection(models, effort),
            spendable - deducted,
            basis,
            tier
          );
          if (pinned.totalNanoUsd !== undefined && pinned.totalNanoUsd > largest) {
            largest = pinned.totalNanoUsd;
          }
        }
        // One available rung settles effort, so no call is made and none is held.
        const held = available.length >= 2 ? deducted : 0n;
        expect(auto.totalNanoUsd).toBe(held + largest);
        compared += 1;
        if (available.length === 1 && deducted > 0n) settled += 1;
      }),
      { numRuns: 300 }
    );
    expect(compared).toBeGreaterThan(100);
    expect(settled).toBeGreaterThan(5);
  });
});

interface RisingTurn {
  readonly selection: Selection;
  readonly basis: PromptBasis;
  readonly tier: UserTier;
  readonly lower: bigint;
  readonly higher: bigint;
}

/**
 * A rise in balance, mostly under half a dollar: a rung's threshold drop happens
 * only between two balances either side of that threshold, so most draws step
 * across one rather than jump far past it.
 */
const rises: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 4, arbitrary: fc.bigInt({ min: 0n, max: 500n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: 40_000n }) }
);

/**
 * Generator `risingSearchingTurns`: a searching turn with its effort open, with or
 * without the Smart slot beside its pinned models, at two balances.
 */
const risingSearchingTurns: fc.Arbitrary<RisingTurn> = fc
  .record({
    pinned: fc.uniqueArray(fc.constantFrom(...IDS), { minLength: 0, maxLength: 2 }),
    slot: fc.boolean(),
    basis: bases,
    tier: tiers,
    a: balances,
    rise: rises,
  })
  .map(({ pinned, slot, basis, tier, a, rise }) => {
    const [first, ...rest] = pinned;
    const selection: Selection = {
      answerSources:
        first === undefined || slot
          ? { models: pinned.map((id) => modelId(id)), smartSlot: true }
          : { models: [modelId(first), ...rest.map((id) => modelId(id))], smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: true,
    };
    return { selection, basis, tier, lower: a, higher: a + rise * 1_000_000n };
  });

function runnableIds(set: OptionSet): readonly string[] {
  return set.sendable ? set.runnable.map((entry) => entry.modelId) : [];
}

describe('a rising balance never shrinks what an Auto searching turn presents', () => {
  it('keeps every row`s ceiling, every rung`s ceiling, the available rungs and the candidates', () => {
    let rungsCompared = 0;
    fc.assert(
      fc.property(risingSearchingTurns, ({ selection, basis, tier, lower, higher }) => {
        const poorer = evaluate(selection, lower, basis, tier).optionSet;
        const richer = evaluate(selection, higher, basis, tier).optionSet;
        const richerRungs = new Set(availableRungs(richer));
        expect(availableRungs(poorer).filter((rung) => !richerRungs.has(rung))).toEqual([]);
        const richerRunnable = new Set(runnableIds(richer));
        expect(runnableIds(poorer).filter((id) => !richerRunnable.has(id))).toEqual([]);
        for (const entry of poorer.all) {
          const richerEntry = entryOf(richer, entry.modelId);
          expect(richerEntry?.ceilingTokens ?? -1).toBeGreaterThanOrEqual(entry.ceilingTokens);
          for (const rung of entry.rungCeilings) {
            const richerRung = richerEntry?.rungCeilings.find(
              (other) => other.effort === rung.effort
            );
            expect(richerRung?.ceilingTokens ?? -1).toBeGreaterThanOrEqual(rung.ceilingTokens);
            rungsCompared += 1;
          }
        }
      }),
      { numRuns: 300 }
    );
    expect(rungsCompared).toBeGreaterThan(200);
  });

  it('offers the available rungs as a prefix of the ladder', () => {
    const ladder: readonly string[] = EFFORT_OPTION_IDS;
    const position = (optionId: string): number => ladder.indexOf(optionId);
    let partial = 0;
    fc.assert(
      fc.property(risingSearchingTurns, ({ selection, basis, tier, lower }) => {
        const set = evaluate(selection, lower, basis, tier).optionSet;
        for (const dimension of set.turnDimensions) {
          const flags = [...dimension.options]
            .toSorted((a, b) => position(a.optionId) - position(b.optionId))
            .map((option) => option.availability.available);
          const firstGreyed = flags.indexOf(false);
          expect(firstGreyed === -1 || !flags.slice(firstGreyed).includes(true)).toBe(true);
          if (flags.includes(true) && flags.includes(false)) partial += 1;
        }
      }),
      { numRuns: 300 }
    );
    expect(partial).toBeGreaterThan(20);
  });
});

interface HeldTurn {
  readonly selection: Selection;
  readonly basis: PromptBasis;
  readonly tier: UserTier;
  readonly spendable: bigint;
  readonly held: bigint;
}

/** Generator `heldSearchingTurns`: {@link risingSearchingTurns}' selections, with a hold out. */
const heldSearchingTurns: fc.Arbitrary<HeldTurn> = fc
  .tuple(risingSearchingTurns, balances)
  .map(([turn, held]) => ({
    selection: turn.selection,
    basis: turn.basis,
    tier: turn.tier,
    spendable: turn.lower,
    held: held / 4n,
  }));

function candidateOptionsAvailable(set: OptionSet, id: string): ReadonlySet<string> {
  const entry = entryOf(set, id);
  if (entry?.kind !== 'candidate') return new Set();
  return new Set(
    entry.dimensions.flatMap((dimension) =>
      dimension.options.flatMap((option) =>
        option.availability.available ? [option.optionId] : []
      )
    )
  );
}

describe('the candidate set of one searching Auto turn as its balance rises', () => {
  it('keeps the engine row between $0.40 and $1.00, one cent at a time', () => {
    // The rungs above Min open one by one across this range. A candidate row graded
    // at the highest available rung's loop drops the engine each time a dearer loop
    // opens; graded at the lowest offered rung's loop, a membership no balance
    // moves, it stays.
    const basis: PromptBasis = {
      systemChars: 0,
      instructionChars: 0,
      historyChars: 0,
      inputChars: 0,
      attachmentBytes: 0,
    };
    const lost: string[] = [];
    let previous: ReadonlySet<string> = new Set();
    for (let cents = 40n; cents <= 100n; cents += 1n) {
      const set = evaluate(
        nonSlotSelection(['vendor/sonnet']),
        cents * 10_000_000n,
        basis,
        'paid'
      ).optionSet;
      const available: ReadonlySet<string> = new Set(
        set.all.filter((row) => row.availability.available).map((row) => row.modelId)
      );
      for (const id of previous) if (!available.has(id)) lost.push(`${id} at ${String(cents)}c`);
      previous = available;
    }
    expect(lost).toEqual([]);
    expect(previous.has('vendor/engine')).toBe(true);
  });
});

describe('admissible is a subset of affordable on a searching Auto turn', () => {
  it('holds for every row, ceiling and candidate rung', () => {
    let sendable = 0;
    fc.assert(
      fc.property(heldSearchingTurns, ({ selection, basis, tier, spendable, held }) => {
        const pair = getTurnOptions(
          {
            spendableNanoUsd: nanoUSD(spendable),
            heldNanoUsd: nanoUSD(held),
            payerTier: tier,
            payer: 'self',
          },
          basis,
          selection,
          { models: CATALOG, nowMs: NOW_MS }
        );
        if (pair.admissible.sendable) sendable += 1;
        expect(pair.admissible.sendable && !pair.affordable.sendable).toBe(false);
        const affordableRungs = new Set(availableRungs(pair.affordable));
        expect(
          availableRungs(pair.admissible).filter((rung) => !affordableRungs.has(rung))
        ).toEqual([]);
        for (const id of IDS) {
          const admissible = entryOf(pair.admissible, id);
          const affordable = entryOf(pair.affordable, id);
          if (admissible === undefined || affordable === undefined) continue;
          if (admissible.availability.available)
            expect(affordable.availability.available).toBe(true);
          expect(affordable.ceilingTokens).toBeGreaterThanOrEqual(admissible.ceilingTokens);
          const affordableOptions = candidateOptionsAvailable(pair.affordable, id);
          const gained = [...candidateOptionsAvailable(pair.admissible, id)].filter(
            (option) => !affordableOptions.has(option)
          );
          expect(gained).toEqual([]);
        }
      }),
      { numRuns: 400 }
    );
    expect(sendable).toBeGreaterThan(50);
  });

  it('holds at the balance edge where the lowest rung first becomes affordable', () => {
    // A directed sweep over the band where the rungs open one by one, so the
    // subset check meets every threshold rather than only the draws that land on one.
    const selection = nonSlotSelection(['vendor/sonnet']);
    const basis: PromptBasis = {
      systemChars: 0,
      instructionChars: 0,
      historyChars: 39_000,
      inputChars: 1000,
      attachmentBytes: 0,
    };
    for (let cents = 10n; cents <= 3000n; cents += 7n) {
      const pair = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD((cents * DOLLAR) / 100n),
          heldNanoUsd: nanoUSD(0n),
          payerTier: 'paid',
          payer: 'self',
        },
        basis,
        selection,
        { models: CATALOG, nowMs: NOW_MS }
      );
      const admissible = entryOf(pair.admissible, 'vendor/sonnet')?.ceilingTokens ?? 0;
      const affordable = entryOf(pair.affordable, 'vendor/sonnet')?.ceilingTokens ?? 0;
      expect(affordable).toBeGreaterThanOrEqual(admissible);
    }
  });
});

/**
 * A slot turn's candidates as the server's candidate list carries them: the
 * menu's runnable rows less the pinned models, in the menu's order, each with a
 * cap per available rung only where a decision can land on two or more rungs
 * beside a pinned searching model.
 */
function slotCandidatesOf(
  runnable: readonly ModelEntry[],
  pinned: readonly string[],
  presented: readonly string[]
): readonly {
  readonly id: string;
  readonly rungCeilings?: Readonly<Partial<Record<ResolvedReasoningEffort, number>>>;
}[] {
  const perRung = pinned.length > 0 && presented.length >= 2;
  return runnable
    .filter((entry) => !pinned.includes(entry.modelId))
    .map((entry) => {
      const rungs = perRung
        ? entry.rungCeilings.filter((rung) => presented.includes(rung.effort))
        : [];
      return rungs.length === 0
        ? { id: entry.modelId }
        : {
            id: entry.modelId,
            rungCeilings: Object.fromEntries(
              rungs.map((rung) => [rung.effort, rung.ceilingTokens])
            ),
          };
    });
}

/** Every kind of line an answer can carry on one axis: each option, one outside, none. */
function answerLines(prefix: string, named: readonly string[], outside: string): string[] {
  return [...named.map((name) => `${prefix}: ${name}`), `${prefix}: ${outside}`, ''];
}

type Rung = (typeof EFFORT_OPTION_IDS)[number];

/** One classifier answer, and the presented rung its effort line names, if any. */
interface ClassifierAnswer {
  readonly text: string;
  readonly named: Rung | undefined;
}

/**
 * Every kind of classifier answer a slot turn can receive: each candidate, an
 * unlisted model and no model line, crossed with each presented rung's label, an
 * unpresented rung's label and no effort line.
 */
function everyAnswer(
  presented: readonly Rung[],
  candidateIds: readonly string[]
): readonly ClassifierAnswer[] {
  const unpresented = EFFORT_OPTION_IDS.find((id) => !presented.includes(id));
  const outside = unpresented === undefined ? 'turbo' : REASONING_EFFORT_LABELS[unpresented];
  const labels = presented.map((id) => REASONING_EFFORT_LABELS[id]);
  const effortLines = answerLines('effort', labels, outside);
  return answerLines('model', candidateIds, 'vendor/unlisted').flatMap((modelLine) =>
    effortLines.map((effortLine) => ({
      text: [modelLine, effortLine].filter((line) => line !== '').join('\n'),
      named: presented[labels.findIndex((label) => effortLine.endsWith(label))],
    }))
  );
}

describe('a Smart Model slot turn decides a rung its bound candidate can run', () => {
  it('decides a presented rung the bound candidate answers at, for every kind of answer', () => {
    let decided = 0;
    let clamped = 0;
    fc.assert(
      fc.property(searchingSlotTurns, ({ pinned, basis, tier, spendable }) => {
        const set = getTurnOptions(
          {
            spendableNanoUsd: nanoUSD(spendable),
            heldNanoUsd: nanoUSD(0n),
            payerTier: tier,
            payer: 'self',
          },
          basis,
          slotSelection(pinned),
          { models: CATALOG, nowMs: NOW_MS }
        ).admissible;
        const available = availableRungs(set);
        const presented = EFFORT_OPTION_IDS.filter((id) => available.includes(id));
        // One available rung settles effort with no classifier call.
        if (!set.sendable || presented.length < 2) return;
        const candidates = slotCandidatesOf(set.runnable, pinned, presented);
        const domain = candidates.map((candidate) => ({
          id: candidate.id,
          answerableRungs: presented.filter(
            (rung) => candidateAnsweringAt(candidate, rung) !== undefined
          ),
        }));
        const answers = everyAnswer(
          presented,
          candidates.map((candidate) => candidate.id)
        );
        for (const answer of answers) {
          const resolution = resolveClassifierAnswer(answer.text, presented, domain);
          const bound = candidates.find((candidate) => candidate.id === resolution.modelId);
          const effort = presented.find((rung) => rung === resolution.effort);
          expect(effort).toBeDefined();
          expect(bound).toBeDefined();
          if (bound === undefined || effort === undefined) continue;
          expect(candidateAnsweringAt(bound, effort)).toBeDefined();
          decided += 1;
          if (answer.named !== undefined && answer.named !== effort) clamped += 1;
        }
      })
    );
    expect(decided).toBeGreaterThan(1000);
    // Answers that bind a candidate above the rungs it answers at, which the
    // decision has to clamp.
    expect(clamped).toBeGreaterThan(10);
  });
});
