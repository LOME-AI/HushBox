/**
 * A searching turn's tool loop follows its effort rung: each rung is priced at
 * its own call budget (`toolCallCapFor`), so a higher rung costs more at the same
 * balance, while a turn with no tool prices every rung alike.
 *
 * Under an open axis every rung the classifier may decide is sized by its own
 * budget solve and the hold covers the dearest of them; the rows, the candidate
 * set and the send gate are graded at the lowest rung's loop; and the picker's
 * pass prices every row at that lowest rung, so what the send gate offers is never
 * greyed in the picker.
 */

import { describe, expect, it } from 'vitest';

import { classifierEngineOf } from '../classifier-engine.ts';
import { EFFORT_OPTION_IDS } from '../dimensions/effort.ts';
import { classifierWorstCaseNanoUsd } from '../estimate/smart-model-affordability.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { getAffordableOptions, getTurnOptions } from './turn-options.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type {
  CandidateModelEntry,
  FundingSnapshot,
  ModelEntry,
  OptionSet,
  PromptBasis,
  Selection,
  TurnOptions,
} from './turn-types.ts';

const NOW_MS = TEST_DAY_START;

/** Stored billable rates of a $3 / $15 model after the fee: 3,450 in and 17,250 out. */
const SONNET: PriceableModel = {
  modelId: modelId('vendor/sonnet'),
  pricing: tokenPricingFixture({ input: nanoUSD(3450n), output: nanoUSD(17_250n) }),
  contextLength: 1_000_000,
  providerCap: 128_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['max', 'high', 'medium', 'low'] },
};

/** The cheapest row in the pool, so it is the classifier engine; its ladder is mandatory. */
const ENGINE: PriceableModel = {
  modelId: modelId('vendor/engine'),
  pricing: tokenPricingFixture({ input: nanoUSD(52n), output: nanoUSD(161n) }),
  contextLength: 131_072,
  providerCap: 16_384,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

/** A mandatory Low/Mid/High row, so its own cheapest corner is Low. */
const MANDATORY: PriceableModel = {
  modelId: modelId('vendor/mandatory'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(5000n) }),
  contextLength: 200_000,
  providerCap: 64_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

/** A row that cannot reason at all. */
const LADDERLESS: PriceableModel = {
  modelId: modelId('vendor/ladderless'),
  pricing: tokenPricingFixture({ input: nanoUSD(200n), output: nanoUSD(800n) }),
  contextLength: 128_000,
  providerCap: 16_000,
  releasedAtMs: 0,
  reasoning: undefined,
};

/** 39,000 history and 1,000 new characters: a 13,334-token prompt at 3 characters per token. */
const BASIS: PromptBasis = {
  systemChars: 0,
  instructionChars: 0,
  historyChars: 39_000,
  inputChars: 1000,
  attachmentBytes: 0,
};

function fundingOf(spendableNanoUsd: bigint, heldNanoUsd = 0n): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendableNanoUsd),
    heldNanoUsd: nanoUSD(heldNanoUsd),
    payerTier: 'paid',
    payer: 'self',
  };
}

function soloSelection(pin: OptionId | undefined, webSearch: boolean): Selection {
  return {
    answerSources: { models: [SONNET.modelId], smartSlot: false },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch,
  };
}

/** Sonnet pinned by name beside the Smart slot, searching, effort open. */
const SLOT_BESIDE_SONNET: Selection = {
  answerSources: { models: [SONNET.modelId], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: true,
};

function optionsAt(
  spendableNanoUsd: bigint,
  pin?: OptionId,
  webSearch = true,
  catalog: readonly PriceableModel[] = [SONNET]
): TurnOptions {
  return getTurnOptions(fundingOf(spendableNanoUsd), BASIS, soloSelection(pin, webSearch), {
    models: catalog,
    nowMs: NOW_MS,
  });
}

function holdOf(options: TurnOptions): bigint {
  if (options.holdNanoUsd === undefined) throw new Error('expected a sendable turn');
  return BigInt(options.holdNanoUsd);
}

function entryOf(set: OptionSet, id: string): ModelEntry {
  const entry = set.all.find((row) => row.modelId === id);
  if (entry === undefined) throw new Error(`no row for ${id}`);
  return entry;
}

function candidateOf(set: OptionSet, id: string): CandidateModelEntry {
  const entry = entryOf(set, id);
  if (entry.kind !== 'candidate') throw new Error(`${id} is not a candidate row`);
  return entry;
}

function availableRungs(set: OptionSet): readonly string[] {
  return set.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

/** The effort-only classifier reserve an open axis buys, from the one shared derivation. */
function effortOnlyReserve(catalog: readonly PriceableModel[]): bigint {
  const engine = classifierEngineOf(catalog);
  if (engine === undefined) throw new Error('the catalog has no classifier engine');
  return classifierWorstCaseNanoUsd(engine, []);
}

/** $60: enough that every rung's loop reaches the provider cap. */
const RICH = 60_000_000_000n;

const DOLLAR = 1_000_000_000n;

describe('a searching turn prices the loop of the rung it runs at', () => {
  it('a searching turn pinned Low holds less than the same turn pinned High', () => {
    expect(holdOf(optionsAt(RICH, 'low'))).toBeLessThan(holdOf(optionsAt(RICH, 'high')));
  });

  it('holds the same amount at every pinned rung when the turn carries no tool', () => {
    const holds = new Set(
      ['off', 'low', 'medium', 'high', 'max'].map((pin) => holdOf(optionsAt(RICH, pin, false)))
    );
    expect(holds.size).toBe(1);
  });

  it('declares the pin as the loop effort under a pin', () => {
    const options = optionsAt(RICH, 'medium');
    expect(options.admissible.toolLoopEffort).toBe('medium');
    expect(options.admissible.holdEffort).toBe('medium');
  });

  it('declares no loop effort for a selection with no reasoning ladder', () => {
    const options = getTurnOptions(
      fundingOf(RICH),
      BASIS,
      {
        answerSources: { models: [LADDERLESS.modelId], smartSlot: false },
        modality: 'text',
        pinned: {},
        webSearch: true,
      },
      { models: [LADDERLESS], nowMs: NOW_MS }
    );
    expect(options.admissible.sendable).toBe(true);
    expect(options.admissible.toolLoopEffort).toBeUndefined();
    expect(options.admissible.holdEffort).toBeUndefined();
  });

  it('lowers the Auto loop effort rather than refusing when a higher rung`s loop is unaffordable', () => {
    const pinnedMax = optionsAt(2n * DOLLAR, 'max');
    const auto = optionsAt(2n * DOLLAR);
    expect(pinnedMax.admissible.sendable).toBe(false);
    expect(auto.admissible.sendable).toBe(true);
    expect(auto.admissible.toolLoopEffort).toBe('low');
  });

  it('publishes each available rung`s own ceiling on the answering row', () => {
    const catalog = [SONNET, ENGINE];
    const auto = optionsAt(10n * DOLLAR, undefined, true, catalog);
    const rungs = entryOf(auto.admissible, SONNET.modelId).rungCeilings;
    expect(rungs.map((rung) => rung.effort)).toEqual(availableRungs(auto.admissible));
    expect(rungs.length).toBeGreaterThan(1);
    // Auto at a rung is the pin at that rung, less what the classifier costs.
    const reserve = effortOnlyReserve(catalog);
    for (const rung of rungs) {
      const pinned = optionsAt(10n * DOLLAR - reserve, rung.effort, true, catalog);
      expect(rung.ceilingTokens).toBe(entryOf(pinned.admissible, SONNET.modelId).ceilingTokens);
    }
  });
});

describe('a menu that marks exactly one rung available settles effort', () => {
  /** 37.5 cents: a searching Sonnet turn whose menu marks only Min available. */
  const ONE_RUNG = 375_000_000n;
  const catalog = [SONNET, ENGINE];

  it('marks exactly one rung available at this balance', () => {
    expect(availableRungs(optionsAt(ONE_RUNG, undefined, true, catalog).admissible)).toEqual([
      'off',
    ]);
  });

  it('holds no classifier reserve for a non-slot turn it settles', () => {
    const reserve = effortOnlyReserve(catalog);
    const auto = optionsAt(ONE_RUNG, undefined, true, catalog);
    const pinned = optionsAt(ONE_RUNG - reserve, 'off', true, catalog);
    expect(holdOf(auto)).toBe(holdOf(pinned));
  });

  it('keeps the ceiling its solve bought with the reserve set aside', () => {
    const reserve = effortOnlyReserve(catalog);
    const auto = optionsAt(ONE_RUNG, undefined, true, catalog);
    const pinned = optionsAt(ONE_RUNG - reserve, 'off', true, catalog);
    expect(entryOf(auto.admissible, SONNET.modelId).ceilingTokens).toBe(
      entryOf(pinned.admissible, SONNET.modelId).ceilingTokens
    );
  });

  it('publishes the reserve its solves set aside', () => {
    expect(optionsAt(ONE_RUNG, undefined, true, catalog).setAsideNanoUsd).toBe(
      effortOnlyReserve(catalog)
    );
  });

  it('sets nothing aside when two or more rungs are available', () => {
    expect(optionsAt(ONE_RUNG, undefined, false, catalog).setAsideNanoUsd).toBeUndefined();
  });

  it('keeps the reserve on a slot turn whose open model axis still buys the call', () => {
    // 80 cents: the slot can resolve to three candidates and only Min is available.
    const options = getTurnOptions(fundingOf(800_000_000n), BASIS, SLOT_BESIDE_SONNET, {
      models: [SONNET, ENGINE, MANDATORY, LADDERLESS],
      nowMs: NOW_MS,
    });
    expect(availableRungs(options.admissible)).toHaveLength(1);
    expect(options.setAsideNanoUsd).toBeUndefined();
  });
});

describe('the directed cases the Auto rule must hold', () => {
  it('never lets the picker`s ceiling fall below the send gate`s when nothing is held', () => {
    const options = optionsAt(DOLLAR, undefined, true, [SONNET, ENGINE]);
    expect(entryOf(options.affordable, SONNET.modelId).ceilingTokens).toBeGreaterThanOrEqual(
      entryOf(options.admissible, SONNET.modelId).ceilingTokens
    );
  });

  it('never greys a candidate rung in the picker that the send gate offers', () => {
    for (const spendable of [DOLLAR, 2n * DOLLAR, 4n * DOLLAR, 10n * DOLLAR]) {
      const options = getTurnOptions(fundingOf(spendable), BASIS, SLOT_BESIDE_SONNET, {
        models: [SONNET, ENGINE, MANDATORY],
        nowMs: NOW_MS,
      });
      for (const id of [ENGINE.modelId, MANDATORY.modelId]) {
        const admissible = candidateOf(options.admissible, id).dimensions.flatMap(
          (dimension) => dimension.options
        );
        const affordable = candidateOf(options.affordable, id).dimensions.flatMap(
          (dimension) => dimension.options
        );
        const gained = admissible.filter(
          (option) =>
            option.availability.available &&
            affordable.some(
              (other) => other.optionId === option.optionId && !other.availability.available
            )
        );
        expect(gained).toEqual([]);
      }
    }
  });

  it('refuses a replace click whose committed turn cannot run at its own cheapest corner', () => {
    const picker = getAffordableOptions(fundingOf(300_000_000n), soloSelection(undefined, true), {
      models: [SONNET, MANDATORY, ENGINE],
      nowMs: NOW_MS,
    });
    expect(candidateOf(picker.affordable, MANDATORY.modelId).activation.replace).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('sends a slot turn with no available rung at the lowest rung`s loop', () => {
    const options = getTurnOptions(fundingOf(375_000_000n), BASIS, SLOT_BESIDE_SONNET, {
      models: [SONNET, ENGINE, LADDERLESS],
      nowMs: NOW_MS,
    });
    expect(availableRungs(options.admissible)).toEqual([]);
    expect(options.admissible.sendable).toBe(true);
    expect(options.admissible.toolLoopEffort).toBe(EFFORT_OPTION_IDS[0]);
  });
});
