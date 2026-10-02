/**
 * `presented ⟺ feasible` — every option presented is feasible, and every
 * feasible option is presented — over the `admissible` set (`docs/BILLING.md`
 * §Invariants, as equations; scoped by §Affordability §The four notions).
 *
 * Presenting a rung is a CONJUNCTION over the arrangement's siblings, so the two
 * directions are graded over different populations and the file says so rather
 * than assuming a fixture where they coincide:
 *
 * - **presented ⟹ feasible** everywhere: an offered rung's own budget leaves a
 *   minimum answer inside the row's own ceiling, and its row runs at all;
 * - **feasible ⟹ presented** where the arrangement is the row ALONE, because
 *   only there does the conjunction reduce to the row's own fit. With a sibling
 *   pinned, a rung whose own budget fits is withheld when that sibling starves at
 *   it — the term a per-model reading of this invariant drops.
 *
 * Both are read off produced rows rather than re-derived: the sibling's ceiling
 * inside a candidate's arrangement is deliberately not published (a pinned row is
 * priced on the pinned siblings alone), so a conjunction restated here would be
 * grading a frame the producer never used.
 *
 * The fixture is deliberately non-degenerate, because one model with one option
 * satisfies the words while proving nothing. What it carries, and why:
 *
 * - **five models**, so a turn has siblings and candidates rather than one row;
 * - **both registered dimensions**, model (open through the smart slot) and
 *   effort (open or pinned);
 * - **a mandatory-reasoning model**, whose cheapest corner is not free, so
 *   eligibility graded on an unreachable zero would be visible here;
 * - **a plateau-collapsed pair**, two rungs clamping to the same budget, so a
 *   presented set counted by label rather than by resolved requirement diverges.
 *
 * Each of those four properties is asserted before the invariant is, so the
 * fixture cannot decay into a degenerate one unnoticed.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { DIMENSION_IDS } from '../dimensions/index.ts';
import { dimensionSupportFor } from '../dimensions/derive.ts';
import { EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { USER_TIERS } from '../money/tiers.ts';
import { reasoningBudgetTokens } from './turn-arithmetic.ts';
import { getTurnOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { UserTier } from '../money/tiers.ts';
import type { CandidateModelEntry, PromptBasis, Selection } from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

interface ModelShape {
  readonly modelId: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly contextLength: number;
  readonly providerCap: number;
  readonly reasoning?: PriceableModel['reasoning'];
}

function modelOf(shape: ModelShape): PriceableModel {
  return {
    modelId: modelId(shape.modelId),
    pricing: tokenPricingFixture({
      input: nanoUSD(shape.inputRate),
      output: nanoUSD(shape.outputRate),
    }),
    contextLength: shape.contextLength,
    providerCap: shape.providerCap,
    releasedAtMs: 0,
    reasoning: shape.reasoning,
  };
}

const LADDER = modelOf({
  modelId: modelId('vendor/ladder'),
  inputRate: 80n,
  outputRate: 200n,
  contextLength: 200_000,
  providerCap: 64_000,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
  },
});
const BUDGET_NATIVE = modelOf({
  modelId: modelId('vendor/budget-native'),
  inputRate: 500n,
  outputRate: 1500n,
  contextLength: 128_000,
  providerCap: 32_000,
  reasoning: {},
});
const MANDATORY = modelOf({
  modelId: modelId('vendor/mandatory'),
  inputRate: 2000n,
  outputRate: 6000n,
  contextLength: 40_000,
  providerCap: 20_000,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
    mandatory: true,
  },
});
/** providerCap 1,200 clamps every rung to 1,200 — the plateau. */
const PLATEAU = modelOf({
  modelId: modelId('vendor/plateau'),
  inputRate: 300n,
  outputRate: 700n,
  contextLength: 6000,
  providerCap: 1200,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
  },
});
const PLAIN = modelOf({
  modelId: modelId('vendor/plain'),
  inputRate: 700n,
  outputRate: 1400n,
  contextLength: 100_000,
  providerCap: 8000,
});

const CATALOG: readonly PriceableModel[] = [LADDER, BUDGET_NATIVE, MANDATORY, PLATEAU, PLAIN];

const BASIS: PromptBasis = {
  systemChars: 800,
  instructionChars: 120,
  historyChars: 3000,
  inputChars: 200,
  attachmentBytes: 0,
};

const SMART_SELECTION: Selection = {
  answerSources: { models: [modelId('vendor/ladder')], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

/**
 * The same turn with nothing pinned, so the ladder model is a CANDIDATE and
 * carries the per-option list this invariant is about. Its arrangement is the
 * ladder alone either way — the pinned-alone and candidate-alone arrangements have
 * the same membership — so the rungs it prices are the ones a pinned row would
 * have had. Every other catalog model is a candidate on its own arrangement too,
 * which is the population that carries the converse.
 */
const NOTHING_PINNED: Selection = {
  ...SMART_SELECTION,
  answerSources: { models: [], smartSlot: true },
};

/**
 * A pin that starves, so the sibling term is exercised rather than assumed away.
 * The mandatory model's top rung reserves more than its whole provider cap, so it
 * starves there at EVERY funding level, while the ladder model fits its own top
 * rung with room to spare — the shape a fixture whose only pin holds the catalog's
 * largest ceiling and cheapest rates can never produce.
 */
const MANDATORY_PINNED: Selection = {
  ...SMART_SELECTION,
  answerSources: { models: [modelId('vendor/mandatory')], smartSlot: true },
};

/** One balance draw per iteration, drawn once so every shape is graded on the same money. */
const BALANCE_SWEEP: readonly bigint[] = fc
  .sample(fc.bigInt({ min: 1n, max: 500n }), 60)
  .map((millicents) => millicents * 1_000_000n);

describe('the fixture is non-degenerate', () => {
  it('carries five models', () => {
    expect(CATALOG).toHaveLength(5);
  });

  it('exercises both registered dimensions — model through the smart slot, effort in the menus', () => {
    expect([...DIMENSION_IDS].toSorted((left, right) => left.localeCompare(right))).toEqual([
      'effort',
      'model',
    ]);
    expect(SMART_SELECTION.answerSources.smartSlot).toBe(true);
    const options = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(200_000_000n),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      BASIS,
      SMART_SELECTION,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const turnDimensions = options.admissible.sendable ? options.admissible.turnDimensions : [];
    expect(turnDimensions.map((dimension) => dimension.dimensionId)).toEqual(['effort']);
    const entries = options.admissible.sendable ? options.admissible.all : [];
    expect(entries.length).toBeGreaterThan(1);
  });

  it('carries a mandatory-reasoning model whose cheapest rung is not free', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, MANDATORY);
    expect(support.mandatory).toBe(true);
    expect(support.options.map((option) => option.optionId)).not.toContain('off');
    expect(reasoningBudgetTokens(MANDATORY, 'low')).toBeGreaterThan(0);
  });

  it('carries a plateau-collapsed pair — two rungs clamping to one budget', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, PLATEAU);
    const rungs = support.options.filter((option) => option.optionId !== 'off');
    const budgets = rungs.map((option) => reasoningBudgetTokens(PLATEAU, option.optionId));
    expect(rungs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(budgets).size).toBeLessThan(budgets.length);
  });
});

/** One candidate row's rungs, split by the direction each one bears on. */
interface Tally {
  readonly presented: number;
  readonly greyed: number;
  /**
   * The rungs a per-model reading would have demanded: withheld though the row
   * runs and this model's own budget fits inside its own ceiling. On an
   * arrangement of one they are a violation; beside a pinned sibling they are the
   * sibling's refusal, and the population the converse cannot be read over.
   */
  readonly withheldWhereOwnFitHolds: readonly string[];
}

/**
 * Assert the forward direction on one entry, and report how the rest of its
 * rungs landed so the caller can grade the converse over the population that
 * carries it and prove both sides were exercised.
 */
function checkEntry(entry: CandidateModelEntry): Tally {
  const model = CATALOG.find((candidate) => candidate.modelId === entry.modelId);
  expect(model).toBeDefined();
  if (model === undefined) return { presented: 0, greyed: 0, withheldWhereOwnFitHolds: [] };
  const options = entry.dimensions.flatMap((dimension) => dimension.options);
  let presented = 0;
  let greyed = 0;
  const withheldWhereOwnFitHolds: string[] = [];
  for (const option of options) {
    const ownFit =
      reasoningBudgetTokens(model, option.optionId) + MINIMUM_OUTPUT_TOKENS <= entry.ceilingTokens;
    if (option.availability.available) {
      // A model the turn cannot run at all greys every one of its options, so an
      // offered rung is a promise about the row as well as about the rung.
      expect(entry.availability.available && ownFit).toBe(true);
      presented += 1;
      continue;
    }
    greyed += 1;
    if (entry.availability.available && ownFit) {
      withheldWhereOwnFitHolds.push(
        `${String(entry.modelId)} ${option.optionId} ceiling=${String(entry.ceilingTokens)}`
      );
    }
  }
  return { presented, greyed, withheldWhereOwnFitHolds };
}

/** Every candidate row one selection produces across the balance sweep, graded. */
function sweepOver(tier: UserTier, selection: Selection): Tally {
  let presented = 0;
  let greyed = 0;
  const withheldWhereOwnFitHolds: string[] = [];
  for (const spendable of BALANCE_SWEEP) {
    const options = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(spendable),
        heldNanoUsd: nanoUSD(0n),
        payerTier: tier,
        payer: tier === 'guest' ? 'owner' : 'self',
      },
      BASIS,
      selection,
      { models: CATALOG, nowMs: NOW_MS }
    );
    if (!options.admissible.sendable) continue;
    for (const entry of options.admissible.all) {
      // `presented ⟺ feasible` is scoped to the decision-bearing rows. A pinned
      // row publishes no option list at all, so there is nothing to check on it.
      if (entry.kind !== 'candidate') continue;
      const counted = checkEntry(entry);
      presented += counted.presented;
      greyed += counted.greyed;
      withheldWhereOwnFitHolds.push(...counted.withheldWhereOwnFitHolds);
    }
  }
  return { presented, greyed, withheldWhereOwnFitHolds };
}

describe('presented is exactly feasible, over the admissible set', () => {
  // Swept over the canonical tier list, never a local copy: the producer's arms
  // differ by tier — premium access and the trial per-message ceiling are both
  // tier-keyed — so an invariant swept over one tier says nothing about the rest.
  it.each(USER_TIERS)(
    'agrees on every model x option assignment across a %s balance sweep',
    (tier) => {
      const alone = sweepOver(tier, NOTHING_PINNED);
      const beside = [SMART_SELECTION, MANDATORY_PINNED].map((selection) =>
        sweepOver(tier, selection)
      );

      // The converse, over the rows whose arrangement is themselves: with no
      // sibling to starve, a fitting rung the menu withholds is a violation.
      expect(alone.withheldWhereOwnFitHolds).toEqual([]);
      // …over a population with both sides in it. An empty list of violations is
      // evidence only if rungs were offered AND withheld in the shape it was
      // collected over.
      expect(alone.presented).toBeGreaterThan(0);
      expect(alone.greyed).toBeGreaterThan(0);
      // The forward direction is asserted per rung as they are counted, so the
      // sibling shapes need only be non-empty to have been graded at all. Summed
      // rather than per shape: the mandatory pin is a premium model, so its turn
      // refuses outright below the paid tier and contributes nothing there.
      expect(beside.reduce((sum, tally) => sum + tally.presented, 0)).toBeGreaterThan(0);
      expect(beside.reduce((sum, tally) => sum + tally.greyed, 0)).toBeGreaterThan(0);
    }
  );

  it('greys the rungs a shrinking ceiling can no longer fit, from the top down', () => {
    const rich = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(500_000_000n),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      BASIS,
      NOTHING_PINNED,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const poor = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(6_000_000n),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      BASIS,
      NOTHING_PINNED,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const rungsOf = (
      set: typeof rich.admissible
    ): readonly { readonly optionId: string; readonly available: boolean }[] => {
      const entry = set.sendable
        ? set.all.find((candidate) => candidate.modelId === 'vendor/ladder')
        : undefined;
      const dimensions = entry?.kind === 'candidate' ? entry.dimensions : [];
      return (dimensions[0]?.options ?? []).map((option) => ({
        optionId: option.optionId,
        available: option.availability.available,
      }));
    };
    expect(rungsOf(rich.admissible).every((rung) => rung.available)).toBe(true);
    const poorRungs = rungsOf(poor.admissible);
    expect(poorRungs.some((rung) => !rung.available)).toBe(true);
    // The feasible set of an ordered dimension is a downward-closed prefix, so
    // an available rung never sits above an unavailable one.
    const firstUnavailable = poorRungs.findIndex((rung) => !rung.available);
    expect(poorRungs.slice(firstUnavailable).every((rung) => !rung.available)).toBe(true);
  });

  it('withholds a rung the candidate itself fits, when the pinned sibling starves at it', () => {
    // The sibling term, measured rather than assumed: every quantity a per-model
    // reading grades the ladder's top rung on says offer it, and the menu
    // withholds it because the pinned model starves there. Drop the conjunct and
    // this rung is offered on a turn that cannot run it.
    const options = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(500_000_000n),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      BASIS,
      MANDATORY_PINNED,
      { models: CATALOG, nowMs: NOW_MS }
    );
    const set = options.admissible;
    const rows = set.sendable ? set.all : [];
    const pin = rows.find((entry) => entry.modelId === 'vendor/mandatory');
    const candidate = rows.find((entry) => entry.modelId === 'vendor/ladder');
    expect(pin?.kind).toBe('pinned');
    expect(candidate?.kind).toBe('candidate');
    if (pin === undefined || candidate?.kind !== 'candidate') return;

    // The pin starves at the top rung on its own published ceiling, and its
    // ceiling beside a candidate is no larger than that, so it starves there too.
    expect(reasoningBudgetTokens(MANDATORY, 'high') + MINIMUM_OUTPUT_TOKENS).toBeGreaterThan(
      pin.ceilingTokens
    );
    // The candidate's own budget fits its own ceiling with room left over, and
    // its row runs — everything a per-model reading grades on says offer it.
    expect(reasoningBudgetTokens(LADDER, 'high') + MINIMUM_OUTPUT_TOKENS).toBeLessThanOrEqual(
      candidate.ceilingTokens
    );
    expect(candidate.availability.available).toBe(true);
    const top = candidate.dimensions
      .flatMap((dimension) => dimension.options)
      .find((option) => option.optionId === 'high');
    expect(top?.availability.available).toBe(false);
  });
});
