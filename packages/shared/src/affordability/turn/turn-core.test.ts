/**
 * The pure core: one `(funding, basis)` pair in, one option set plus the priced
 * line items out. The producer runs it twice; these pins are on one pass at a
 * time, so the arithmetic can be read without the two-set substitution on top.
 */

import { describe, expect, it } from 'vitest';

import { classifierEngineOf } from '../classifier-engine.ts';
import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '../estimate/reasoning-plan.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { USER_TIERS } from '../money/tiers.ts';
import { ASSISTANT_FRAMING_MAX_CHARS } from '../../assistant-text/grammar.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { toolCallBillableNano } from '../estimate/tool-pricing.ts';
import { WEB_SEARCH_RESULT_MAX_CHARS, toolCallCapFor, toolLoopBound } from '../tool-loop.ts';
import { evaluateTurn } from './turn-core.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { ModelId } from '../model/model-id.ts';
import type { CoreInput, CoreResult } from './turn-core.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { CandidateModelEntry, PromptBasis, RefusalCode, Selection } from './turn-types.ts';

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

const CHEAP = modelOf({
  modelId: modelId('vendor/cheap'),
  inputRate: 100n,
  outputRate: 200n,
  contextLength: 100_000,
  providerCap: 32_000,
  reasoning: {
    supportedEfforts: ['high', 'medium', 'low'],
  },
});
const PLAIN = modelOf({
  modelId: modelId('vendor/plain'),
  inputRate: 1000n,
  outputRate: 2000n,
  contextLength: 100_000,
  providerCap: 8000,
});
const TIGHT = modelOf({
  modelId: modelId('vendor/tight'),
  inputRate: 1000n,
  outputRate: 2000n,
  contextLength: 4000,
  providerCap: 4000,
});
const PRICEY = modelOf({
  modelId: modelId('vendor/pricey'),
  inputRate: 50_000n,
  outputRate: 100_000n,
  contextLength: 100_000,
  providerCap: 32_000,
});

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

/** A reasoning model, so a pool built from it publishes rungs to grade. */
const REASONER = modelOf({
  modelId: 'vendor/reasoner',
  inputRate: 1000n,
  outputRate: 2000n,
  contextLength: 100_000,
  providerCap: 8000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
});

/**
 * Released inside the premium recency window, so a free-tier payer is locked out
 * of it on TIER at any balance. Its rates match {@link REASONER}'s, so neither is
 * an excluded outlier and both reach the pool — which is what lets a pool hold a
 * tier-locked member beside one blocked for a reason the payer can act on.
 */
const LOCKED_REASONER: PriceableModel = {
  ...REASONER,
  modelId: modelId('vendor/locked-reasoner'),
  releasedAtMs: NOW_MS - 1000,
};
const LOCKED_TWIN: PriceableModel = {
  ...LOCKED_REASONER,
  modelId: modelId('vendor/locked-twin'),
};

/**
 * Dear enough that its worst-case trial turn runs past the trial per-message cap,
 * while {@link PLAIN} stays under it. Within an order of magnitude of PLAIN, so
 * neither is an excluded outlier and both reach the pool.
 */
const TRIAL_CAPPED = modelOf({
  modelId: 'vendor/trial-capped',
  inputRate: 5000n,
  outputRate: 10_000n,
  contextLength: 100_000,
  providerCap: 8000,
});

const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 400,
  inputChars: 200,
  attachmentBytes: 0,
};

function selectionOf(models: readonly string[], overrides: Partial<Selection> = {}): Selection {
  return {
    answerSources: {
      models: models.map((id) => modelId(id)) as [ModelId, ...ModelId[]],
      smartSlot: false,
    },
    modality: 'text',
    pinned: {},
    webSearch: false,
    ...overrides,
  };
}

function inputOf(overrides: Partial<CoreInput> = {}): CoreInput {
  return {
    fundingNanoUsd: 1_000_000_000n,
    basis: BASIS,
    selection: selectionOf(['vendor/plain']),
    catalog: [PLAIN],
    tier: 'paid',
    nowMs: NOW_MS,
    ...overrides,
  };
}

/** Nothing pinned, so every catalog model is a candidate and carries its rungs. */
const SLOT_ONLY: Selection = {
  answerSources: { models: [], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

function refusalOf(result: CoreResult): RefusalCode | undefined {
  return result.optionSet.sendable ? undefined : result.optionSet.refusal;
}

/** The candidate set proper — what a classifier may route among, in its own order. */
function runnableIdsOf(result: CoreResult): readonly string[] {
  return result.optionSet.sendable ? result.optionSet.runnable.map((entry) => entry.modelId) : [];
}

/**
 * One candidate row. Per-model option lists are asserted through this rather than
 * off `all`, because only the candidate kind carries them: a pinned row's own-fit
 * verdicts are no decision's business and the type does not publish them.
 */
function candidateOf(result: CoreResult, modelId: string): CandidateModelEntry | undefined {
  const entry = result.optionSet.all.find((candidate) => candidate.modelId === modelId);
  return entry?.kind === 'candidate' ? entry : undefined;
}

/** One rung's availability in the turn-level menu — what a user would see. */
function turnRungAvailable(result: CoreResult, optionId: string): boolean | undefined {
  return result.optionSet.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability.available;
}

/** One greyed rung's reason in the turn-level menu — the sentence it carries. */
function turnRungReason(result: CoreResult, optionId: string): RefusalCode | undefined {
  const availability = result.optionSet.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability;
  return availability === undefined || availability.available ? undefined : availability.reason;
}

describe('modality', () => {
  it('refuses a per-unit modality rather than pricing it against a token ceiling', () => {
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/plain'], { modality: 'image' }) })
    );
    expect(refusalOf(result)).toBe('modality_not_priceable');
    expect(result.totalNanoUsd).toBeUndefined();
  });

  it('prices the token path for text', () => {
    expect(evaluateTurn(inputOf()).optionSet.sendable).toBe(true);
  });
});

describe('line items', () => {
  it('carries input and output storage on a persisting turn', () => {
    const labels = evaluateTurn(inputOf()).lineItems.map((item) => item.label);
    expect(labels).toContain('input-storage');
    expect(labels).toContain('output-storage');
  });

  it('carries no storage line item at all on a trial turn, which never persists', () => {
    const items = evaluateTurn(inputOf({ tier: 'trial', fundingNanoUsd: 10_000_000n })).lineItems;
    expect(items.filter((item) => item.kind === 'storage')).toEqual([]);
  });

  it('prices input storage once per turn, not once per sibling', () => {
    const three = evaluateTurn(
      inputOf({
        selection: selectionOf(['vendor/cheap', 'vendor/plain', 'vendor/tight']),
        catalog: [CHEAP, PLAIN, TIGHT],
      })
    );
    const charged = three.lineItems
      .filter((item) => item.label === 'input-storage')
      .reduce((sum, item) => sum + (item.fixedNano ?? 0n), 0n);
    // The 200 new-message characters at 300 nano per character, attributed to
    // the first sibling exactly as settlement attributes it to the first charge.
    expect(charged).toBe(60_000n);
    const nonZero = three.lineItems.filter(
      (item) => item.label === 'input-storage' && (item.fixedNano ?? 0n) > 0n
    );
    expect(nonZero).toHaveLength(1);
  });

  it('prices a whole tool loop on each of three searching siblings', () => {
    const three = evaluateTurn(
      inputOf({
        selection: selectionOf(['vendor/cheap', 'vendor/plain', 'vendor/tight'], {
          webSearch: true,
        }),
        catalog: [CHEAP, PLAIN, TIGHT],
      })
    );
    const fees = three.lineItems.filter((item) => item.label === 'tool-call-fees');
    // Every sibling's loop allows the call budget of the rung the hold is priced
    // at, each call at the after-fee web-search rate.
    const heldAt = three.optionSet.holdEffort;
    expect(heldAt).toBeDefined();
    expect(fees.map((item) => item.fixedNano)).toEqual(
      Array.from(
        { length: 3 },
        () => BigInt(toolCallCapFor(heldAt)) * toolCallBillableNano('webSearch')
      )
    );
  });

  it('holds a searching sibling’s whole tool loop, its per-output-token legs included', () => {
    // PLAIN at its 8,000-token cap, funded past it: 334 prompt tokens and 11
    // steps for 10 calls, at the ceiling of its 1,000 / 2,000 rates. Every term
    // of the loop is here once, the model's own re-sent output (55 × the cap at
    // the input rate) and the tool-use overhead on the 10 tool-carrying steps
    // among them.
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 2_000_000_000n,
        selection: selectionOf(['vendor/plain'], { webSearch: true }),
      })
    );
    const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
    const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
    expect(result.totalNanoUsd).toBe(
      11n * 334n * 1250n +
        11n * 8000n * (2500n + 1500n) +
        55n * 8000n * 1250n +
        10n * 10n * resultTokens * 1250n +
        10n * overheadTokens * 1250n +
        10n * toolCallBillableNano('webSearch') +
        BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n +
        BigInt(ASSISTANT_FRAMING_MAX_CHARS) * 300n +
        200n * 300n
    );
  });

  it('prices no tool loop when web search is off', () => {
    const labels = evaluateTurn(inputOf()).lineItems.map((item) => item.label);
    expect(labels).not.toContain('tool-call-fees');
  });

  it('reserves nothing for a slot-only turn, whose one answer carries no tools field', () => {
    const slotOnly = evaluateTurn(
      inputOf({
        selection: { ...SLOT_ONLY, webSearch: true },
        catalog: [CHEAP, PLAIN, TIGHT],
      })
    );
    const labels = slotOnly.lineItems.map((item) => item.label);
    expect(labels).not.toContain('tool-call-fees');
  });

  it('reserves for a mixed turn’s pinned siblings and not for the slot beside them', () => {
    const mixed = evaluateTurn(
      inputOf({
        selection: selectionOf(['vendor/cheap', 'vendor/plain'], {
          answerSources: {
            models: [modelId('vendor/cheap'), modelId('vendor/plain')],
            smartSlot: true,
          },
          webSearch: true,
        }),
        catalog: [CHEAP, PLAIN, TIGHT],
      })
    );
    const fees = mixed.lineItems.filter((item) => item.label === 'tool-call-fees');
    // One loop per pinned sibling. Three models can answer this turn once the
    // slot is counted, so a third loop would be the slot's. Two is what
    // excludes it.
    expect(fees).toHaveLength(2);
  });
});

describe('the classifier reserve', () => {
  it('is absent when no dimension is open', () => {
    const labels = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/plain'], { pinned: { effort: 'off' } }) })
    ).lineItems.map((item) => item.label);
    expect(labels).not.toContain('classifier-tokens');
  });

  it('is present when the effort dimension is open with two distinct resolved budgets', () => {
    const labels = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/cheap']), catalog: [CHEAP] })
    ).lineItems.map((item) => item.label);
    expect(labels).toContain('classifier-tokens');
  });

  it('prices the reserve identically whichever order a rate-tied catalog arrives in', () => {
    const first = modelOf({
      modelId: modelId('vendor/aaa'),
      inputRate: 100n,
      outputRate: 200n,
      contextLength: 100_000,
      providerCap: 32_000,
      reasoning: {
        supportedEfforts: ['high', 'medium', 'low'],
      },
    });
    // Same combined rate, different split: the two tie on the rate the engine
    // choice is ordered by, so arrival order is the only thing left that could
    // move the reserve.
    const second = modelOf({
      modelId: modelId('vendor/zzz'),
      inputRate: 1n,
      outputRate: 299n,
      contextLength: 100_000,
      providerCap: 32_000,
      reasoning: {
        supportedEfforts: ['high', 'medium', 'low'],
      },
    });
    const reserveOf = (catalog: readonly PriceableModel[]): bigint | undefined =>
      evaluateTurn(
        inputOf({ catalog, selection: selectionOf([catalog[0]?.modelId ?? '']) })
      ).lineItems.find((item) => item.label === 'classifier-tokens')?.fixedNano;
    const forwards = reserveOf([first, second]);
    const backwards = reserveOf([second, first]);
    expect(forwards).toBeDefined();
    expect(backwards).toBe(forwards);
  });

  it('carries no storage leg on any tier, because its prompt and output never rest', () => {
    for (const tier of USER_TIERS) {
      const items = evaluateTurn(
        inputOf({ tier, catalog: [CHEAP], selection: selectionOf(['vendor/cheap']) })
      ).lineItems;
      expect(items.map((item) => item.label)).not.toContain('classifier-storage');
    }
  });

  /**
   * The reserve prices the list the classifier prompt will CARRY, which is the
   * classifier-selectable pool when a smart slot is open and nothing at all
   * otherwise. Pricing a different list than the executor prompts leaves the
   * error's sign undecided, and an unsigned error is not an upper bound however
   * large it happens to be.
   */
  const extraModels = (count: number): PriceableModel[] =>
    Array.from({ length: count }, (_, index) =>
      modelOf({
        // Dearer than CHEAP on both legs, so the cheapest engine cannot move.
        modelId: `vendor/extra-${String(index)}`,
        inputRate: 5000n,
        outputRate: 9000n,
        contextLength: 100_000,
        providerCap: 32_000,
      })
    );

  const reserveNano = (result: CoreResult): bigint | undefined =>
    result.lineItems.find((item) => item.label === 'classifier-tokens')?.fixedNano;

  it('prices no model list on a turn whose only open dimension is effort', () => {
    const reserveWith = (extras: readonly PriceableModel[]): bigint | undefined =>
      reserveNano(
        evaluateTurn(
          inputOf({ catalog: [CHEAP, ...extras], selection: selectionOf(['vendor/cheap']) })
        )
      );
    const bare = reserveWith([]);
    expect(bare).toBeDefined();
    // No smart slot, so the classifier prompt lists no models at all: catalog
    // size cannot move the reserve.
    expect(reserveWith(extraModels(40))).toBe(bare);
  });

  it('prices the classifier-selectable pool, not the catalog, when a slot is open', () => {
    const reserveWith = (extras: readonly PriceableModel[]): bigint | undefined =>
      reserveNano(evaluateTurn(inputOf({ catalog: [CHEAP, ...extras], selection: SLOT_ONLY })));
    const bare = reserveWith([]);
    expect(bare).toBeDefined();
    // The pool grows with the catalog here, so the prompt genuinely gets longer
    // and the reserve must follow it.
    expect(reserveWith(extraModels(40))).toBeGreaterThan(bare ?? 0n);
  });
});

describe('the ceiling', () => {
  it('prices the turn at Σ cost(m, ceiling(m)) plus new-message storage', () => {
    const result = evaluateTurn(inputOf());
    // 1,000 prompt chars at 3 chars/token = 334 input tokens; the ceiling is the
    // 8,000-token provider cap; the rates are held at the ceiling of 1,000 /
    // 2,000, so variableRate = 2,500 output + 1,500 storage.
    // Prompt storage prices the 200 NEW-message characters, not all 1,000, and
    // the answer's framing allowance is 640 × 300.
    // 334 × 1,250 + 8,000 × 4,000 + 200 × 300 + 192,000 = 32,669,500.
    expect(result.totalNanoUsd).toBe(32_669_500n);
  });

  it('prices input storage over the new message in the manifest and the solve alike', () => {
    // The solve reads `inputStorage` and the manifest emits an `input-storage`
    // line item; both derive from the same basis, so a turn cannot be reserved
    // against one number and presented as another.
    const result = evaluateTurn(inputOf());
    const storage = result.lineItems.find((item) => item.label === 'input-storage');
    expect(storage?.fixedNano).toBe(60_000n);
  });

  it('holds the input-storage term still as the history grows', () => {
    const longHistory = evaluateTurn(
      inputOf({ basis: { ...BASIS, historyChars: BASIS.historyChars + 20_000 } })
    );
    const storage = longHistory.lineItems.find((item) => item.label === 'input-storage');
    expect(storage?.fixedNano).toBe(60_000n);
  });

  it('is bound by the provider cap when money and prompt leave more room', () => {
    const result = evaluateTurn(inputOf());
    const entry = result.optionSet.sendable ? result.optionSet.all[0] : undefined;
    expect(entry?.ceilingTokens).toBe(8000);
  });

  it('is bound by what the money buys when the balance is small', () => {
    const result = evaluateTurn(inputOf({ fundingNanoUsd: 6_000_000n }));
    const entry = result.optionSet.sendable ? result.optionSet.all[0] : undefined;
    // fixedCosts = 334 x 1,250 + 60,000 + 192,000 framing = 669,500;
    // variableRate = 2,500 + 1,500; floor(5,330,500 / 4,000) = 1,332.
    expect(entry?.ceilingTokens).toBe(1332);
  });

  it('is bound by the context headroom on a tight-context model', () => {
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/tight']), catalog: [TIGHT] })
    );
    const entry = result.optionSet.sendable ? result.optionSet.all[0] : undefined;
    expect(entry?.ceilingTokens).toBe(4000 - 334);
  });
});

describe('one shared token count, per-model physical bounds', () => {
  // §Sharing one budget across siblings: `T` is solved once against the SUMMED
  // variable rates, and each sibling then clamps it with its OWN `providerCap`
  // and `contextHeadroom`. `vendor/plain` and `vendor/tight` are deliberately
  // heterogeneous on both physical bounds, so the two clamps land on different
  // siblings and neither reading can be mistaken for the other.
  function pair(funding: bigint): CoreResult {
    return evaluateTurn(
      inputOf({
        fundingNanoUsd: funding,
        catalog: [PLAIN, TIGHT],
        selection: selectionOf(['vendor/plain', 'vendor/tight']),
      })
    );
  }

  function ceilingOf(result: CoreResult, modelId: string): number | undefined {
    return result.optionSet.all.find((entry) => entry.modelId === modelId)?.ceilingTokens;
  }

  it('leaves the wide sibling on its own provider cap while the tight one takes its own context headroom', () => {
    // 1,000 prompt chars at 3 chars/token = 334 input tokens, each sibling's
    // rates held at the ceiling of 1,000 / 2,000.
    // fixedCosts = 334 × (1,250 + 1,250) + 200 × 300 + 2 × 192,000 = 1,279,000;
    // Σ variableRate = 2 × (2,500 + 1,500) = 8,000, so
    // T = floor((1,000,000,000 − 1,279,000) / 8,000) = 124,840 — far above both
    // siblings' physical room, so only the physical bounds bind here.
    const result = pair(1_000_000_000n);
    // vendor/plain: min(providerCap 8,000, contextHeadroom 100,000 − 334, T).
    expect(ceilingOf(result, 'vendor/plain')).toBe(8000);
    // vendor/tight: min(providerCap 4,000, contextHeadroom 4,000 − 334, T) — the
    // tight sibling's own 3,666 does NOT pull the wide sibling below 8,000, and
    // the wide sibling's 8,000 does not lift the tight one above its context.
    expect(ceilingOf(result, 'vendor/tight')).toBe(3666);
  });

  it('prices the pair at Σ cost(m, ceiling(m)), not at T × Σ rates', () => {
    const result = pair(1_000_000_000n);
    // cost(plain, 8,000) = 334 × 1,250 + 8,000 × 4,000 + 200 × 300 (prompt
    // storage rides the first sibling only) + 192,000 framing = 32,669,500.
    // cost(tight, 3,666) = 334 × 1,250 + 3,666 × 4,000 + 192,000 = 15,273,500.
    expect(result.totalNanoUsd).toBe(47_943_000n);
    // The forbidden summed-rate basis on this very turn: fixedCosts + T × Σ rates
    // = 1,279,000 + 124,840 × 8,000 = 999,999,000 — effectively the whole funding,
    // which is why §Multi-Model 2 forbids it as a charge basis even though `T` is
    // solved against those same summed rates. The number is recorded, not
    // asserted: an assertion over test-side arithmetic alone cannot fail for any
    // change to the priced basis above.
  });

  it('shares the money bound when the money is what binds, leaving both physical clamps loose', () => {
    // fixedCosts = 1,279,000 with both framings; T = floor((11,000,000 −
    // 1,279,000) / 8,000) = 1,215 — below both siblings' physical room, so ONE
    // shared count binds both.
    const result = pair(11_000_000n);
    expect(ceilingOf(result, 'vendor/plain')).toBe(1215);
    expect(ceilingOf(result, 'vendor/tight')).toBe(1215);
  });
});

describe('the smart slot`s MAX enters the shared token solve', () => {
  // §The hold: the smart slot contributes `MAX` over its candidates, and that
  // maximum is what the shared token count is solved against — so the ceiling
  // the turn delivers is sized for the worst candidate the classifier could
  // pick, never for the cheapest.
  //
  // Every model id below is the same length and the same three ids appear in both
  // catalogs, and `vendor/eng1` is the cheapest combined rate in both — so the
  // classifier reserve (priced from the prompted pool's ids, on the cheapest
  // engine) is identical across the two evaluations and the difference is the
  // candidate rates alone.
  const ENGINE = modelOf({
    modelId: modelId('vendor/eng1'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 100_000,
    providerCap: 32_000,
  });
  const MID = modelOf({
    modelId: modelId('vendor/mid1'),
    inputRate: 1000n,
    outputRate: 2000n,
    contextLength: 100_000,
    providerCap: 32_000,
  });
  const DEAR = modelOf({
    modelId: modelId('vendor/dear'),
    inputRate: 4000n,
    outputRate: 8000n,
    contextLength: 100_000,
    providerCap: 32_000,
  });
  /** Same id as {@link DEAR}, at {@link MID}'s rates: the control catalog. */
  const DEAR_AS_MID = modelOf({
    modelId: modelId('vendor/dear'),
    inputRate: 1000n,
    outputRate: 2000n,
    contextLength: 100_000,
    providerCap: 32_000,
  });
  // Sized so the CHEAPER candidate's arrangement is bound by the provider cap
  // while the dearer one is still bound by the money: were both money-bound, every
  // arrangement would price at roughly the whole funding and the control below
  // could not tell a MAX from a MIN.
  const FUNDING = 200_000_000n;

  function slotTurn(catalog: readonly PriceableModel[]): CoreResult {
    return evaluateTurn(
      inputOf({
        fundingNanoUsd: FUNDING,
        catalog,
        selection: {
          answerSources: { models: [modelId('vendor/eng1')], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
      })
    );
  }

  it('solves a smaller shared count for the dearer candidate than for the cheaper one', () => {
    const result = slotTurn([ENGINE, MID, DEAR]);
    // Each candidate row is graded on its own arrangement, so the dearer
    // candidate's arrangement buys strictly fewer tokens at the same funding —
    // which is the shared count `T` differing per arrangement.
    expect(candidateOf(result, 'vendor/dear')?.ceilingTokens).toBeLessThan(
      candidateOf(result, 'vendor/mid1')?.ceilingTokens ?? 0
    );
  });

  it('sizes the hold on the dearest candidate, not the cheapest', () => {
    const withDear = slotTurn([ENGINE, MID, DEAR]);
    const control = slotTurn([ENGINE, MID, DEAR_AS_MID]);
    expect(withDear.totalNanoUsd).toBeDefined();
    // Only the dearest candidate's rates changed between the two catalogs, so a
    // hold taken over anything but the MAX would have priced both identically.
    expect(withDear.totalNanoUsd ?? 0n).toBeGreaterThan(control.totalNanoUsd ?? 0n);
  });
});

describe('reasons, in the precedence the specification fixes', () => {
  it('reports money when the funding cannot cover a minimum answer at all', () => {
    const result = evaluateTurn(inputOf({ fundingNanoUsd: 600_000n }));
    expect(refusalOf(result)).toBe('insufficient_funds');
  });

  it('reports length when the funding could pay but the prompt leaves no room', () => {
    const longPrompt: PromptBasis = { ...BASIS, historyChars: 15_000 };
    const result = evaluateTurn(
      inputOf({
        basis: longPrompt,
        selection: selectionOf(['vendor/tight']),
        catalog: [TIGHT],
      })
    );
    expect(refusalOf(result)).toBe('prompt_too_long');
  });

  it("reports a model's own output cap when neither money nor prompt binds", () => {
    const capped = modelOf({
      modelId: modelId('vendor/capped'),
      inputRate: 100n,
      outputRate: 200n,
      contextLength: 100_000,
      providerCap: 500,
    });
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/capped']), catalog: [capped] })
    );
    expect(refusalOf(result)).toBe('model_output_cap_too_low');
  });

  it('reports an unpriceable model when the selection names one the catalog lacks', () => {
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/absent']), catalog: [PLAIN] })
    );
    expect(refusalOf(result)).toBe('model_not_priceable');
  });

  it('reports an unoffered option when a pinned id is outside the dimension`s domain', () => {
    // Fail closed on an effort id no dimension declares: it has no order, so
    // nothing sits below it, and running the turn would mean silently dropping a
    // parameter the caller asked for. Every id the domain DOES declare resolves
    // — downward, or upward on a mandatory ladder — so this is the one shape
    // that reaches the refusal.
    const result = evaluateTurn(
      inputOf({
        catalog: [CHEAP],
        selection: selectionOf(['vendor/cheap'], { pinned: { effort: 'ultra' } }),
      })
    );
    expect(refusalOf(result)).toBe('option_not_offered');
  });

  it('refuses a turn whose smart slot has no candidate', () => {
    const result = evaluateTurn(
      inputOf({
        selection: {
          answerSources: { models: [], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
        catalog: [],
      })
    );
    expect(refusalOf(result)).toBe('model_not_priceable');
  });

  it('reports a smart pool`s money reason rather than a tier lock only some members carry', () => {
    // Same rates on both members, so neither is an excluded outlier and both
    // reach the pool: one blocked on money, the other on tier alone.
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 600_000n,
        selection: SLOT_ONLY,
        catalog: [REASONER, LOCKED_REASONER],
        tier: 'free',
      })
    );
    expect(refusalOf(result)).toBe('insufficient_funds');
  });

  it('greys a smart pool`s rung on the money reason its own send gate gives', () => {
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 600_000n,
        selection: SLOT_ONLY,
        catalog: [REASONER, LOCKED_REASONER],
        tier: 'free',
      })
    );
    expect(turnRungReason(result, 'off')).toBe('insufficient_funds');
  });

  it('keeps a trial pool`s per-message cap in contention with the money reason beside it', () => {
    // The cap is not unconditional: its own copy asks the user to shorten the
    // message, and shortening clears it. Yielding it would answer a trial payer
    // with a balance notice, which is the one action a trial payer cannot take.
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 600_000n,
        selection: SLOT_ONLY,
        catalog: [PLAIN, TRIAL_CAPPED],
        tier: 'trial',
      })
    );
    expect(refusalOf(result)).toBe('trial_message_cap_exceeded');
  });

  it('reports a pinned id nothing prices ahead of a wholly premium-locked pool', () => {
    // The pin blocks the turn whatever the pool does, so clearing it is necessary
    // in every version of this scenario and costs the payer nothing; adding credit
    // costs money and still would not send. That asymmetry is why the pin's reason
    // survives here rather than the premium lock outranking it.
    const result = evaluateTurn(
      inputOf({
        selection: {
          answerSources: { models: [modelId('vendor/absent')], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
        catalog: [LOCKED_REASONER, LOCKED_TWIN],
        tier: 'free',
      })
    );
    expect(refusalOf(result)).toBe('model_not_priceable');
  });

  it('reports the tier lock when a smart pool carries no other reason', () => {
    const result = evaluateTurn(
      inputOf({
        selection: SLOT_ONLY,
        catalog: [LOCKED_REASONER, LOCKED_TWIN],
        tier: 'free',
      })
    );
    expect(refusalOf(result)).toBe('premium_requires_credit');
  });
});

describe('entries are marked, never filtered', () => {
  it('renders one entry per catalog model, marking an unavailable one rather than dropping it', () => {
    const result = evaluateTurn(
      inputOf({
        // Past CHEAP's cheapest rung: this case is about entries being marked
        // rather than filtered, so the turn has to send, and an open effort
        // axis that classifies now needs a rung it can run.
        fundingNanoUsd: 20_000_000n,
        // PRICEY is the unavailable row: funding past CHEAP's cheapest rung
        // leaves the cheaper rows affordable, so the marked-not-filtered claim
        // needs a model no plausible funding here reaches.
        catalog: [CHEAP, PLAIN, TIGHT, PRICEY],
        selection: selectionOf(['vendor/cheap']),
      })
    );
    expect(result.optionSet.sendable).toBe(true);
    const all = result.optionSet.sendable ? result.optionSet.all : [];
    expect(
      all.map((entry) => entry.modelId).toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['vendor/cheap', 'vendor/plain', 'vendor/pricey', 'vendor/tight']);
    expect(all.some((entry) => !entry.availability.available)).toBe(true);
  });

  it('keeps an unavailable effort option present with its reason', () => {
    const result = evaluateTurn(
      inputOf({ fundingNanoUsd: 20_000_000n, catalog: [CHEAP], selection: SLOT_ONLY })
    );
    const entry = candidateOf(result, 'vendor/cheap');
    const effort = entry?.dimensions.find((dimension) => dimension.dimensionId === 'effort');
    expect(effort?.options.map((option) => option.optionId)).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    const unavailable = effort?.options.filter((option) => !option.availability.available) ?? [];
    expect(unavailable.length).toBeGreaterThan(0);
    for (const option of unavailable) {
      expect(option.availability).toHaveProperty('reason');
    }
  });

  it('omits the effort dimension for a model that cannot reason, rather than an empty list', () => {
    const result = evaluateTurn(inputOf({ selection: SLOT_ONLY }));
    expect(candidateOf(result, 'vendor/plain')?.dimensions).toEqual([]);
  });
});

describe('the two kinds of row', () => {
  it('gives a pinned row its own verdict and no per-option list', () => {
    // A pinned sibling's per-option own-fit verdicts are finer than the turn's and
    // no decision may consume them, so the row publishes only what it owes — which
    // sibling is the problem — and nothing a control could mistake for a choice.
    // The compile-time half of the same rule lives in `turn-types.test.ts`.
    const result = evaluateTurn(
      inputOf({ catalog: [CHEAP, PLAIN], selection: selectionOf(['vendor/cheap']) })
    );
    const pinned = result.optionSet.all.find((entry) => entry.modelId === 'vendor/cheap');
    expect(pinned).toEqual({
      kind: 'pinned',
      modelId: modelId('vendor/cheap'),
      availability: { available: true },
      ceilingTokens: expect.any(Number),
      rungCeilings: expect.any(Array),
    });
  });

  it('gives a candidate row the per-option list a decision reads', () => {
    const result = evaluateTurn(
      inputOf({ catalog: [CHEAP, PLAIN], selection: selectionOf(['vendor/plain']) })
    );
    const candidate = result.optionSet.all.find((entry) => entry.modelId === 'vendor/cheap');
    expect(candidate?.kind).toBe('candidate');
    const dimensions = candidate?.kind === 'candidate' ? candidate.dimensions : [];
    expect(
      dimensions.flatMap((dimension) => dimension.options).map((option) => option.optionId)
    ).toEqual(['off', 'low', 'medium', 'high']);
  });
});

describe('a refused turn still renders', () => {
  /** A balance that cannot fund a minimum answer on anything in the catalog. */
  const BROKE = { fundingNanoUsd: 600_000n, catalog: [CHEAP, PLAIN, TIGHT] };

  it('carries one row per catalog model, each with its own reason', () => {
    const result = evaluateTurn(
      inputOf({ ...BROKE, selection: selectionOf(['vendor/plain', 'vendor/tight']) })
    );
    expect(refusalOf(result)).toBe('insufficient_funds');
    expect(
      result.optionSet.all
        .map((entry) => entry.modelId)
        .toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['vendor/cheap', 'vendor/plain', 'vendor/tight']);
    for (const entry of result.optionSet.all) {
      expect(entry.availability).toHaveProperty('reason');
    }
  });

  it('carries the turn-level rungs, greyed, so the effort menu has rows to draw', () => {
    const result = evaluateTurn(inputOf({ ...BROKE, selection: selectionOf(['vendor/cheap']) }));
    expect(result.optionSet.sendable).toBe(false);
    expect(turnRungAvailable(result, 'low')).toBe(false);
  });

  it('offers no runnable list, because nothing can run', () => {
    const result = evaluateTurn(inputOf({ ...BROKE, selection: selectionOf(['vendor/plain']) }));
    expect(result.optionSet).not.toHaveProperty('runnable');
    expect(result.totalNanoUsd).toBeUndefined();
  });
});

describe('turn-level dimensions', () => {
  it('presents the union of the selection`s offered rungs', () => {
    const result = evaluateTurn(
      inputOf({ catalog: [CHEAP, PLAIN], selection: selectionOf(['vendor/cheap', 'vendor/plain']) })
    );
    const turnDimensions = result.optionSet.sendable ? result.optionSet.turnDimensions : [];
    const effort = turnDimensions.find((dimension) => dimension.dimensionId === 'effort');
    expect(effort?.options.map((option) => option.label)).toEqual(['Min', 'Low', 'Mid', 'High']);
  });

  it('carries no model dimension, because the model options are the entries themselves', () => {
    const result = evaluateTurn(
      inputOf({ catalog: [CHEAP], selection: selectionOf(['vendor/cheap']) })
    );
    const turnDimensions = result.optionSet.sendable ? result.optionSet.turnDimensions : [];
    expect(turnDimensions.map((dimension) => dimension.dimensionId)).toEqual(['effort']);
  });
});

describe('the turn-level menu is the send gate, one rung at a time', () => {
  /** Cap 64,000: High's 32,768-token budget fits beside a minimum answer. */
  const WIDE = modelOf({
    modelId: modelId('v/wide'),
    inputRate: 60n,
    outputRate: 150n,
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });
  /** Cap 9,000: Low's 4,096 fits beside an answer, Mid and High clamp to 9,000 and cannot. */
  const NARROW = modelOf({
    modelId: modelId('v/narrow'),
    inputRate: 60n,
    outputRate: 150n,
    contextLength: 200_000,
    providerCap: 9000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });

  const RUNGS = ['off', 'low', 'medium', 'high'] as const;

  function turnOf(
    models: readonly string[],
    catalog: readonly PriceableModel[],
    pin?: string
  ): CoreResult {
    return evaluateTurn(
      inputOf({
        fundingNanoUsd: 1_000_000_000n,
        catalog,
        selection: selectionOf(models, pin === undefined ? {} : { pinned: { effort: pin } }),
      })
    );
  }

  /** Every rung the menu carries, in order, with its verdict — enabled or its reason. */
  function menuOf(result: CoreResult): readonly string[] {
    const effort = result.optionSet.turnDimensions.find(
      (dimension) => dimension.dimensionId === 'effort'
    );
    return (effort?.options ?? []).map((option) =>
      option.availability.available
        ? `${option.optionId}=enabled`
        : `${option.optionId}=${option.availability.reason}`
    );
  }

  it('greys a rung one pinned sibling cannot honour, though its sibling can', () => {
    // §Story 2.1: "any effort where a pinned sibling cannot fit B +
    // MINIMUM_OUTPUT_TOKENS inside its ceiling is gone turn-wide … the pinned
    // models are not chooseable, so they cap the whole turn." The AND is over the
    // pinned siblings; §Story 2.8's "at least one" is about CANDIDATES, which a
    // selection with no smart slot has none of. Money binds on neither rung here
    // — both refusals are the narrow model's own output cap — so the fixture
    // isolates the quantifier.
    const menu = turnOf(['v/wide', 'v/narrow'], [WIDE, NARROW]);
    expect(menuOf(menu)).toEqual([
      'off=enabled',
      'low=enabled',
      'medium=model_output_cap_too_low',
      'high=model_output_cap_too_low',
    ]);
  });

  it('names the pinned sibling that blocks the turn, leaving the sibling that fits available', () => {
    // The diagnosis §Story 1.3 wants surfaced, and the reason a pinned row is
    // graded on its OWN fit: the row that cannot honour the pin carries the reason
    // while the row that can stays available, even though the turn cannot start.
    // Grading pinned rows by the arrangement would give both rows the same borrowed
    // reason and delete the answer to "which sibling is the problem". The row is
    // where that lives now — a pinned row publishes no rungs, so the per-rung
    // divergence this replaces is a compile error rather than a documented one.
    const result = turnOf(['v/wide', 'v/narrow'], [WIDE, NARROW], 'high');
    expect(refusalOf(result)).toBe('model_output_cap_too_low');
    expect(
      result.optionSet.all.map((entry) =>
        entry.availability.available
          ? `${entry.modelId}=available`
          : `${entry.modelId}=${entry.availability.reason}`
      )
    ).toEqual(['v/wide=available', 'v/narrow=model_output_cap_too_low']);
  });

  it('enables exactly the rungs a pin of that rung can send', () => {
    // The pairing §Reasoning Effort 3 demands, over the same selection: the menu
    // may never enable a level the send gate refuses, and greying a level the
    // gate accepts hides affordable capability. Asserted against the ONE call's
    // menu, so neither side can drift.
    const menu = turnOf(['v/wide', 'v/narrow'], [WIDE, NARROW]);
    const gate = RUNGS.map(
      (rung) =>
        `${rung}=${String(turnOf(['v/wide', 'v/narrow'], [WIDE, NARROW], rung).optionSet.sendable)}`
    );
    expect(RUNGS.map((rung) => `${rung}=${String(turnRungAvailable(menu, rung))}`)).toEqual(gate);
  });

  it('keeps offering the rungs a lower pin could send when the pinned rung refuses', () => {
    // The mirror of the same defect: a menu merged from the ROWS greys every rung
    // of a row the turn cannot run, so the turn that refuses at High also greys
    // Low — hiding the one rung that would let the payer send at all.
    const refused = turnOf(['v/narrow'], [NARROW], 'high');
    expect(refusalOf(refused)).toBe('model_output_cap_too_low');
    expect(menuOf(refused)).toEqual([
      'off=enabled',
      'low=enabled',
      'medium=model_output_cap_too_low',
      'high=model_output_cap_too_low',
    ]);
    expect(turnOf(['v/narrow'], [NARROW], 'low').optionSet.sendable).toBe(true);
  });

  it('carries the rungs its candidates offer on an unsendable smart-slot turn', () => {
    // Nothing is runnable, so a menu whose rows come from the runnable entries has
    // no rows at all — and the payer who cannot send is exactly the payer whose
    // greying needs explaining. The menu's rows come from the arrangements the
    // turn could become, whose membership no balance moves.
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 600_000n,
        catalog: [WIDE, NARROW],
        selection: {
          answerSources: { models: [], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
      })
    );
    expect(result.optionSet.sendable).toBe(false);
    expect(menuOf(result)).toEqual([
      'off=insufficient_funds',
      'low=insufficient_funds',
      'medium=insufficient_funds',
      'high=insufficient_funds',
    ]);
  });

  it('refuses a selection naming an unpriceable model even when its siblings fit', () => {
    const result = turnOf(['v/wide', 'v/absent'], [WIDE, NARROW]);
    expect(refusalOf(result)).toBe('model_not_priceable');
    expect(turnRungAvailable(result, 'low')).toBe(true);
  });

  /** One candidate row's rungs, in order, with each verdict — enabled or its reason. */
  function rowRungsOf(result: CoreResult, modelId: string): readonly string[] {
    const entry = candidateOf(result, modelId);
    return (entry?.dimensions.flatMap((dimension) => dimension.options) ?? []).map((option) =>
      option.availability.available
        ? `${option.optionId}=enabled`
        : `${option.optionId}=${option.availability.reason}`
    );
  }

  it('caps a candidate row`s rungs by the tightest pinned sibling', () => {
    // §Story 2.2: a candidate's effort ceiling is "its highest feasible level
    // after per-model resolution, capped by the tightest pinned sibling". That
    // annotation is what §Reasoning Effort 8 clamps a classifier answer onto, so a
    // ceiling above what the candidate's own arrangement honours would clamp a
    // joint (model, effort) pick onto a rung a PINNED sibling has no answer room
    // for. The candidate here fits High on its own 64,000-token cap; the pinned
    // sibling's 9,000 cannot, and it is in every arrangement.
    const result = turnOf(['v/narrow'], [WIDE, NARROW]);
    expect(rowRungsOf(result, 'v/wide')).toEqual([
      'off=enabled',
      'low=enabled',
      'medium=model_output_cap_too_low',
      'high=model_output_cap_too_low',
    ]);
  });

  it('keeps a candidate row`s lower rungs when the pinned rung makes the row unavailable', () => {
    // The row-level twin of the greyed-menu defect: greying every rung of an
    // unavailable row hides the rung that would make it available again.
    const result = turnOf(['v/narrow'], [WIDE, NARROW], 'high');
    expect(refusalOf(result)).toBe('model_output_cap_too_low');
    const wide = result.optionSet.all.find((entry) => entry.modelId === 'v/wide');
    expect(wide?.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
    expect(rowRungsOf(result, 'v/wide')).toEqual([
      'off=enabled',
      'low=enabled',
      'medium=model_output_cap_too_low',
      'high=model_output_cap_too_low',
    ]);
  });
});

describe('the empty basis is the zero-length prompt', () => {
  it('leaves the whole context window as answer room', () => {
    const result = evaluateTurn(
      inputOf({
        basis: EMPTY_PROMPT_BASIS,
        selection: selectionOf(['vendor/tight']),
        catalog: [TIGHT],
      })
    );
    const entry = result.optionSet.sendable ? result.optionSet.all[0] : undefined;
    expect(entry?.ceilingTokens).toBe(4000);
  });

  it('prices no input storage, because there is no prompt to store', () => {
    const labels = evaluateTurn(inputOf({ basis: EMPTY_PROMPT_BASIS })).lineItems.map(
      (item) => item.label
    );
    expect(labels).toContain('input-storage');
    const inputStorage = evaluateTurn(inputOf({ basis: EMPTY_PROMPT_BASIS })).lineItems.find(
      (item) => item.label === 'input-storage'
    );
    expect(inputStorage?.fixedNano).toBe(0n);
  });
});

describe('the smart slot', () => {
  it('holds the MAX over candidates, never the sum', () => {
    // CHEAP's larger provider cap buys it more tokens than PLAIN's, so CHEAP's
    // arrangement is the DEARER of the two and is the MAX the hold is sized on.
    const dearestSolo = evaluateTurn(
      inputOf({ catalog: [CHEAP, PLAIN], selection: selectionOf(['vendor/cheap']) })
    );
    const smart = evaluateTurn(
      inputOf({
        catalog: [CHEAP, PLAIN],
        selection: {
          answerSources: { models: [], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
      })
    );
    expect(smart.totalNanoUsd).toBeDefined();
    expect(dearestSolo.totalNanoUsd).toBeDefined();
    // The MAX: the hold covers the dearest candidate's own arrangement, which a
    // hold sized on the cheapest candidate would fall short of.
    expect(smart.totalNanoUsd ?? 0n).toBeGreaterThanOrEqual(dearestSolo.totalNanoUsd ?? 0n);
    // Never the sum: one candidate answers, so the hold is one sibling's cost.
    const bothSiblings = evaluateTurn(
      inputOf({ catalog: [CHEAP, PLAIN], selection: selectionOf(['vendor/cheap', 'vendor/plain']) })
    );
    expect(smart.totalNanoUsd ?? 0n).toBeLessThan(bothSiblings.totalNanoUsd ?? 0n);
  });

  it('presents only candidates that can fund a minimum answer beside the pinned siblings', () => {
    const result = evaluateTurn(
      inputOf({
        fundingNanoUsd: 20_000_000n,
        catalog: [CHEAP, PLAIN, PRICEY],
        selection: {
          answerSources: { models: [modelId('vendor/cheap')], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
      })
    );
    expect(result.optionSet.sendable).toBe(true);
    const runnable = result.optionSet.sendable
      ? result.optionSet.runnable.map((entry) => entry.modelId)
      : [];
    expect(runnable).toEqual(['vendor/cheap', 'vendor/plain']);
    const pricey = result.optionSet.sendable
      ? result.optionSet.all.find((entry) => entry.modelId === 'vendor/pricey')
      : undefined;
    expect(pricey?.availability).toEqual({ available: false, reason: 'insufficient_funds' });
  });
});

describe('the hold covers every presented candidate`s arrangement', () => {
  // Short identifiers deliberately: the classifier reserve prices the prompt
  // overhead from the model ids, so their character counts are load-bearing on
  // every amount pinned in this block.
  const SLOT_PIN = modelOf({
    modelId: modelId('v/pin'),
    inputRate: 60n,
    outputRate: 150n,
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });
  // Every model here carries a ladder, candidates included: a pinned rung no
  // candidate offers refuses the turn outright, so a ladderless candidate would
  // make the whole pinned half of this block's sweep vacuous rather than
  // pin-independent.
  const SLOT_CHEAP = modelOf({
    modelId: modelId('v/cheap'),
    inputRate: 5n,
    outputRate: 10n,
    contextLength: 128_000,
    providerCap: 65_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });
  const SLOT_DEAR = modelOf({
    modelId: modelId('v/dear'),
    inputRate: 20_000n,
    outputRate: 90_000n,
    contextLength: 64_000,
    providerCap: 32_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });
  const SLOT_CATALOG = [SLOT_PIN, SLOT_CHEAP, SLOT_DEAR];

  const LONG_BASIS: PromptBasis = {
    systemChars: 2000,
    instructionChars: 0,
    historyChars: 2000,
    inputChars: 1000,
    attachmentBytes: 0,
  };

  function smartSlotBeside(pin: 'high' | undefined): Selection {
    return {
      answerSources: { models: [modelId('v/pin')], smartSlot: true },
      modality: 'text',
      pinned: pin === undefined ? {} : { effort: pin },
      webSearch: false,
    };
  }

  function slotTurn(funding: bigint, pin: 'high' | undefined): CoreResult {
    return evaluateTurn(
      inputOf({
        fundingNanoUsd: funding,
        basis: LONG_BASIS,
        catalog: SLOT_CATALOG,
        selection: smartSlotBeside(pin),
      })
    );
  }

  function reserveOf(result: CoreResult): bigint {
    return result.lineItems.find((item) => item.label === 'classifier-tokens')?.fixedNano ?? 0n;
  }

  /**
   * The priced total of the arrangement one candidate would create, measured
   * through the same production path rather than re-derived: the same turn with
   * that candidate PINNED in place of the slot, so the arrangement's membership
   * is identical.
   *
   * The resolved turn need not buy the classifier the smart slot bought, so its
   * funding is corrected by the two reserves — both read off produced line items,
   * neither recomputed. `fixedCosts` differ by exactly that reserve, so equalising
   * `funding − reserve` gives both solves the same shared token count, and the
   * resolved total minus its own reserve is the arrangement's sibling cost.
   * A classifier reserve carries no funding term at all — it is priced from the
   * tier and the pool the classifier prompt would name — so reading it off a first
   * pricing pass cannot bias the second.
   */
  function arrangementTotal(
    candidateId: string,
    funding: bigint,
    pin: 'high' | undefined
  ): bigint | undefined {
    const selection: Selection = {
      answerSources: { models: [modelId('v/pin'), modelId(candidateId)], smartSlot: false },
      modality: 'text',
      pinned: pin === undefined ? {} : { effort: pin },
      webSearch: false,
    };
    const priceAt = (at: bigint): CoreResult =>
      evaluateTurn(
        inputOf({ fundingNanoUsd: at, basis: LONG_BASIS, catalog: SLOT_CATALOG, selection })
      );
    const ownReserve = reserveOf(priceAt(funding));
    const resolved = priceAt(funding - reserveOf(slotTurn(funding, pin)) + ownReserve);
    if (resolved.totalNanoUsd === undefined) return undefined;
    return resolved.totalNanoUsd - ownReserve + reserveOf(slotTurn(funding, pin));
  }

  function presentedCandidateIds(result: CoreResult): readonly string[] {
    if (!result.optionSet.sendable) return [];
    return result.optionSet.runnable
      .map((entry) => entry.modelId)
      .filter((modelId) => modelId !== 'v/pin');
  }

  it('withholds a candidate whose arrangement starves a pinned sibling', () => {
    // At this balance v/dear itself fits a minimum answer — its own ceiling is
    // 1,447 tokens — but the arrangement it would create leaves the PINNED
    // sibling only those same 1,447 tokens, which its High budget cannot fit.
    // §Story 1.2 grades a candidate on "B + MINIMUM_OUTPUT_TOKENS inside every
    // sibling's ceiling", and §Story 1.3 makes the pinned siblings a hard gate.
    const result = slotTurn(210_000_000n, 'high');
    expect(result.optionSet.sendable).toBe(true);
    expect(presentedCandidateIds(result)).toEqual(['v/cheap']);
    const dear = result.optionSet.all.find((entry) => entry.modelId === 'v/dear');
    expect(dear?.availability).toEqual({ available: false, reason: 'insufficient_funds' });
    // The hold is v/cheap's arrangement and carries NO classifier reserve. v/dear's
    // `maxCallCost` is past 20× the pool median's, so `outlier(m)` keeps it out of
    // the classifier-selectable set; that leaves one selectable candidate, and one
    // candidate beside a pinned effort is nothing to classify (§Reserve ⟺ classify
    // is decided on pool size). At the caps, every rate held at its ceiling:
    // 1,667 prompt tokens × (75 + 7), 64,000 × (188 + 1,500) and 65,000 ×
    // (13 + 1,500) output, and 1,000 new characters plus two 640-character
    // framings at 300 each.
    expect(result.totalNanoUsd).toBe(207_197_694n);
    expect(reserveOf(result)).toBe(0n);
    const ceilingOf = (modelId: string): number | undefined =>
      result.optionSet.all.find((entry) => entry.modelId === modelId)?.ceilingTokens;
    expect(ceilingOf('v/pin')).toBe(64_000);
    expect(ceilingOf('v/cheap')).toBe(65_000);
  });

  it('holds at least the priced total of every arrangement a presented candidate can create', () => {
    // The money half of the same defect, as a property: the classifier is
    // presented the admissible set and picks from it without re-minting, so an
    // arrangement the hold's MAX never priced is a `reserve ⊇ bill` violation
    // (§Affordability — "the one place where using the wrong set is a money
    // defect"). Swept across both effort regimes, because the pin is not what
    // creates the divergence.
    for (const pin of ['high', undefined] as const) {
      let checked = 0;
      let withheld = 0;
      let sendable = 0;
      for (let millicents = 20; millicents <= 400; millicents += 1) {
        const funding = BigInt(millicents) * 1_000_000n;
        const result = slotTurn(funding, pin);
        if (!result.optionSet.sendable) continue;
        sendable += 1;
        const presented = presentedCandidateIds(result);
        withheld += SLOT_CATALOG.length - 1 - presented.length;
        for (const candidateId of presented) {
          const total = arrangementTotal(candidateId, funding, pin);
          // An arrangement the resolved turn cannot even send is one no hold
          // covers at all, so the presented set has to exclude it outright.
          expect(total).toBeDefined();
          expect(result.totalNanoUsd ?? 0n).toBeGreaterThanOrEqual(total ?? 0n);
          checked += 1;
        }
      }
      // Floored PER REGIME, not across both. A regime that presented nothing, or
      // that never withheld a candidate, satisfies the property while
      // constraining nothing — and an aggregate floor lets the other regime pay
      // for it, which is one fixture edit away now that a pin can withhold a
      // candidate outright.
      const regime = `pin=${String(pin)}`;
      expect(sendable, regime).toBeGreaterThan(50);
      expect(checked, regime).toBeGreaterThan(50);
      expect(withheld, regime).toBeGreaterThan(25);
    }
  });
});

describe('an explicit effort pin on a model with no rung to run', () => {
  /**
   * One native word, mandatory: no CHOICE exists, but the single rung is real and
   * priced. Its 32,000-token provider cap cannot hold High's 32,000-token clamped
   * budget beside a minimum answer, so it is refused on its own physical bound —
   * an honest verdict, not a resolution failure.
   */
  const MANDATORY_SINGLE = modelOf({
    modelId: modelId('vendor/mandatory-single'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 100_000,
    providerCap: 32_000,
    reasoning: { supportedEfforts: ['high'], mandatory: true },
  });

  /** The same shape with room for that budget plus a minimum answer. */
  const MANDATORY_SINGLE_WIDE = modelOf({
    modelId: modelId('vendor/mandatory-single-wide'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: { supportedEfforts: ['high'], mandatory: true },
  });

  /**
   * A full three-rung ladder with room for High's budget beside a minimum answer
   * and none for Max's. It is the downward-resolution witness: a Max pin lands on
   * High, so a core that stopped resolving downward — or resolved upward — would
   * refuse it instead.
   */
  const DOWNWARD = modelOf({
    modelId: modelId('vendor/downward'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 200_000,
    providerCap: REASONING_BUDGET_TOKENS_BY_EFFORT.high + MINIMUM_OUTPUT_TOKENS,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });

  /**
   * CHEAP's own rates and cap with no reasoning field at all. Priced level with
   * the pool so `outlier(m)` cannot be what removes it: the only thing that can
   * withhold this row under a pin is its empty ladder.
   */
  const LADDERLESS_TWIN = modelOf({
    modelId: modelId('vendor/ladderless-twin'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 100_000,
    providerCap: 32_000,
  });

  /** The same ladder one token short of holding High's budget beside that answer. */
  const DOWNWARD_TIGHT = modelOf({
    modelId: modelId('vendor/downward-tight'),
    inputRate: 100n,
    outputRate: 200n,
    contextLength: 200_000,
    providerCap: REASONING_BUDGET_TOKENS_BY_EFFORT.high + MINIMUM_OUTPUT_TOKENS - 1,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });

  it('refuses every pin on a model with no rung, rather than answering it unreasoned', () => {
    for (const pin of ['off', 'lite', 'low', 'medium', 'high', 'max'] as const) {
      const result = evaluateTurn(
        inputOf({ selection: selectionOf(['vendor/plain'], { pinned: { effort: pin } }) })
      );
      expect(refusalOf(result)).toBe('option_not_offered');
    }
  });

  it('withholds a candidate with no ladder from the candidate set under a pin', () => {
    const catalog = [CHEAP, PLAIN];
    const shared = { catalog, fundingNanoUsd: 10n ** 15n };
    const open = evaluateTurn(inputOf({ ...shared, selection: SLOT_ONLY }));
    const pinned = evaluateTurn(
      inputOf({ ...shared, selection: { ...SLOT_ONLY, pinned: { effort: 'low' } } })
    );
    // Withheld, not merely down-ranked: the row leaves `runnable` entirely, so
    // neither the classifier's options nor `candidates[0]`'s fallback binding can
    // reach a model that would have answered at no rung at all.
    expect(runnableIdsOf(open)).toContain('vendor/plain');
    expect(runnableIdsOf(pinned)).toEqual(['vendor/cheap']);
  });

  it('refuses the turn when no candidate can offer the pinned rung', () => {
    const result = evaluateTurn(
      inputOf({
        catalog: [PLAIN],
        fundingNanoUsd: 10n ** 15n,
        selection: { ...SLOT_ONLY, pinned: { effort: 'low' } },
      })
    );
    expect(refusalOf(result)).toBe('option_not_offered');
  });

  it('resolves a pin above the ladder down onto the model`s own top rung', () => {
    const result = evaluateTurn(
      inputOf({
        catalog: [DOWNWARD],
        selection: selectionOf(['vendor/downward'], { pinned: { effort: 'max' } }),
      })
    );
    expect(result.optionSet.sendable).toBe(true);
  });

  it('reserves the resolved rung`s own budget, not nothing', () => {
    // One token less room than High needs beside a minimum answer refuses the
    // same Max pin on the physical bound — so the resolution landed on High and
    // reserved its budget, rather than dropping the axis for a model that has one.
    const result = evaluateTurn(
      inputOf({
        catalog: [DOWNWARD_TIGHT],
        selection: selectionOf(['vendor/downward-tight'], { pinned: { effort: 'max' } }),
      })
    );
    expect(refusalOf(result)).toBe('model_output_cap_too_low');
  });

  it('resolves every pin onto a mandatory single-rung model rather than calling it unoffered', () => {
    for (const pin of ['off', 'lite', 'low', 'medium', 'high', 'max'] as const) {
      const result = evaluateTurn(
        inputOf({
          catalog: [MANDATORY_SINGLE_WIDE],
          selection: selectionOf(['vendor/mandatory-single-wide'], { pinned: { effort: pin } }),
        })
      );
      expect(result.optionSet.sendable).toBe(true);
    }
  });

  it('refuses on the physical cap, not the pin, when the rung leaves no answer room', () => {
    for (const pin of ['off', 'lite', 'low', 'medium', 'high', 'max'] as const) {
      const result = evaluateTurn(
        inputOf({
          catalog: [MANDATORY_SINGLE],
          selection: selectionOf(['vendor/mandatory-single'], { pinned: { effort: pin } }),
        })
      );
      expect(refusalOf(result)).toBe('model_output_cap_too_low');
    }
  });

  it('sends a heterogeneous selection at exactly the rungs its own menu enables', () => {
    // §Reasoning Effort 3: the menu can never enable a level the server refuses.
    // The menu is the union of the selection's offered rungs (§Reasoning Effort
    // 4), so a sibling that cannot reason resolves to no reasoning rather than
    // vetoing every rung the reasoning sibling offers. Both directions are
    // asserted against the SAME call's menu, so neither side can drift.
    const heterogeneous = {
      models: [modelId('vendor/cheap'), modelId('vendor/plain')],
      catalog: [CHEAP, PLAIN],
    };
    const menu = evaluateTurn(
      inputOf({
        catalog: heterogeneous.catalog,
        selection: selectionOf(heterogeneous.models),
      })
    );
    let enabled = 0;
    let greyed = 0;
    for (const pin of ['off', 'low', 'medium', 'high'] as const) {
      const available = turnRungAvailable(menu, pin);
      expect(available).toBeDefined();
      const pinnedResult = evaluateTurn(
        inputOf({
          catalog: heterogeneous.catalog,
          selection: selectionOf(heterogeneous.models, { pinned: { effort: pin } }),
        })
      );
      expect(pinnedResult.optionSet.sendable).toBe(available);
      if (available === true) enabled += 1;
      else greyed += 1;
    }
    // Both sides of the biconditional have to occur, or one direction is untested.
    expect(enabled).toBeGreaterThan(0);
    expect(greyed).toBeGreaterThan(0);
  });

  /** A ladderless sibling beside a smart slot whose candidates do offer the rungs. */
  const SLOT_BESIDE_PLAIN: Selection = {
    answerSources: { models: [modelId('vendor/plain')], smartSlot: true },
    modality: 'text',
    pinned: {},
    webSearch: false,
  };

  it('sends a pin the smart slot can answer, running the ladderless sibling wire-silent', () => {
    // The union the menu presents is taken over every sibling of every presented
    // arrangement, candidates included (§Reasoning Effort 4), so a rung a
    // candidate offers is a rung the turn offers. Refusing it would collapse that
    // union to an intersection and refuse a turn the execution layer runs
    // correctly — the ladderless sibling simply carries no reasoning wire
    // (§Reasoning Effort 9).
    for (const pin of ['off', 'low', 'medium'] as const) {
      const result = evaluateTurn(
        inputOf({
          catalog: [CHEAP, PLAIN],
          selection: { ...SLOT_BESIDE_PLAIN, pinned: { effort: pin } },
        })
      );
      expect(refusalOf(result)).toBeUndefined();
    }
  });

  it('leaves the unpinned menu of that same selection untouched by the pin predicate', () => {
    // An unpinned turn never asks the predicate anything, so its rungs are graded
    // exactly as they are for a selection that could not carry a pin at all: the
    // grading of a rung must not depend on nothing being pinned yet.
    const menu = evaluateTurn(inputOf({ catalog: [CHEAP, PLAIN], selection: SLOT_BESIDE_PLAIN }));
    expect(turnRungAvailable(menu, 'off')).toBe(true);
    expect(turnRungAvailable(menu, 'low')).toBe(true);
    expect(turnRungAvailable(menu, 'medium')).toBe(true);
    // High is refused on CHEAP's physical output cap, not on any ladder — the
    // greyed arm has to be a money-or-physics reason for this to test anything.
    expect(turnRungAvailable(menu, 'high')).toBe(false);
  });

  it('withholds a ladderless candidate beside a pinned sibling that does offer the rung', () => {
    // The pin gates what the CLASSIFIER may pick, whatever else the turn can
    // answer: §Reasoning Effort 3 refuses a pin no candidate can offer rather
    // than binding one that would answer at some other rung — or, here, at none.
    // A pinned sibling running wire-silent is the payer's own explicit choice of
    // that model; a candidate is not.
    const result = evaluateTurn(
      inputOf({
        catalog: [CHEAP, LADDERLESS_TWIN, DOWNWARD],
        selection: selectionOf(['vendor/cheap'], {
          answerSources: { models: [modelId('vendor/cheap')], smartSlot: true },
          pinned: { effort: 'low' },
        }),
      })
    );
    // The turn runs — on the candidate that offers the rung — so the withholding
    // is visible as an absence from `runnable` rather than as a refusal.
    expect(runnableIdsOf(result)).toContain('vendor/downward');
    expect(runnableIdsOf(result)).not.toContain('vendor/ladderless-twin');
  });
});

describe('eligibility is graded on the resolved cheapest corner', () => {
  it('excludes a mandatory-reasoning model whose ceiling fits only the answer', () => {
    // providerCap 2,000: B(low) clamps to 2,000, so B + 1,000 cannot fit.
    const mandatory = modelOf({
      modelId: modelId('vendor/mandatory'),
      inputRate: 100n,
      outputRate: 200n,
      contextLength: 100_000,
      providerCap: 2000,
      reasoning: {
        supportedEfforts: ['high', 'medium', 'low'],
        mandatory: true,
      },
    });
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/mandatory']), catalog: [mandatory] })
    );
    expect(result.optionSet.sendable).toBe(false);
    // The same ceiling admits a model that can switch reasoning off — at a
    // PINNED Min, which is what closes the axis. The corner rule is about which
    // option an open axis is graded on, and it still holds; what an open axis
    // additionally needs is a rung the classifier could pick.
    const disableable = modelOf({
      modelId: modelId('vendor/disableable'),
      inputRate: 100n,
      outputRate: 200n,
      contextLength: 100_000,
      providerCap: 2000,
      reasoning: {
        supportedEfforts: ['high', 'medium', 'low'],
      },
    });
    const admitted = evaluateTurn(
      inputOf({
        selection: selectionOf(['vendor/disableable'], { pinned: { effort: 'off' } }),
        catalog: [disableable],
      })
    );
    expect(admitted.optionSet.sendable).toBe(true);
    const entry = admitted.optionSet.sendable ? admitted.optionSet.all[0] : undefined;
    expect(entry?.ceilingTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
  });

  it('sends a disable-capable model on an OPEN axis, where only Min fits', () => {
    // The cap clamps every rung onto the whole window, so none of them leaves a
    // minimum answer beside it. The turn still sends: a laddered model that
    // answers with no reasoning wire is a legal turn, so the gate grades the
    // resolved cheapest corner — Min — and the ladder only narrows which rungs
    // the menu offers.
    const disableable = modelOf({
      modelId: modelId('vendor/disableable'),
      inputRate: 100n,
      outputRate: 200n,
      contextLength: 100_000,
      providerCap: 2000,
      reasoning: {
        supportedEfforts: ['high', 'medium', 'low'],
      },
    });
    const result = evaluateTurn(
      inputOf({ selection: selectionOf(['vendor/disableable']), catalog: [disableable] })
    );
    expect(result.optionSet.sendable).toBe(true);
    const entry = result.optionSet.sendable ? result.optionSet.all[0] : undefined;
    expect(entry?.ceilingTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
  });
});

describe('candidate order — §Smart Model 1', () => {
  /**
   * Identifier order and cost order DISAGREE here, which is the whole point: a
   * fixture whose ids happen to be alphabetical in cost order cannot tell a cost
   * ordering from a database row ordering, and that is how a row-ordered menu
   * once survived a green suite.
   *
   * The order is load-bearing beyond presentation. `candidates[0]` is the
   * declared cheapest-presented fallback the smart-slot execution runs whenever
   * the classifier's answer names nothing in the list, so row order at position
   * zero decides which model runs and what the payer is billed.
   */
  const EXPENSIVE = modelOf({
    modelId: modelId('a/expensive'),
    inputRate: 30n,
    outputRate: 60n,
    contextLength: 100_000,
    providerCap: 8000,
  });
  const MIDDLE = modelOf({
    modelId: modelId('m/middle'),
    inputRate: 10n,
    outputRate: 20n,
    contextLength: 100_000,
    providerCap: 8000,
  });
  const CHEAPEST = modelOf({
    modelId: modelId('z/cheap'),
    inputRate: 1n,
    outputRate: 2n,
    contextLength: 100_000,
    providerCap: 8000,
  });

  function turnFor(catalog: readonly PriceableModel[], fundingNanoUsd: bigint): CoreResult {
    return evaluateTurn(inputOf({ selection: SLOT_ONLY, catalog, fundingNanoUsd }));
  }

  function runnableIds(catalog: readonly PriceableModel[]): readonly string[] {
    return runnableIdsOf(turnFor(catalog, 10n ** 15n));
  }

  it('orders candidates by ascending turn cost, not by the order the catalog arrived in', () => {
    expect(runnableIds([EXPENSIVE, MIDDLE, CHEAPEST])).toEqual([
      'z/cheap',
      'm/middle',
      'a/expensive',
    ]);
  });

  it('answers the same order whichever order the catalog rows arrive in', () => {
    expect(runnableIds([CHEAPEST, MIDDLE, EXPENSIVE])).toEqual(
      runnableIds([EXPENSIVE, MIDDLE, CHEAPEST])
    );
  });

  it('breaks a turn-cost tie on the identifier', () => {
    const twin = {
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
      providerCap: 8000,
    };
    const twinB = modelOf({ ...twin, modelId: modelId('b/twin') });
    const twinA = modelOf({ ...twin, modelId: modelId('a/twin') });
    expect(runnableIds([twinB, twinA])).toEqual(['a/twin', 'b/twin']);
  });

  it('orders candidates on turn cost, not on the per-token rate the engine ranks by', () => {
    // Capacity is what tells the two bases apart, so it is what this pool varies.
    // `maxCallCost` prices min(providerCap, contextHeadroom) tokens; the combined
    // per-token rate prices none of them. The wide row is the cheapest per token
    // and the dearest turn, the narrow row the reverse, so the two orders are
    // exact opposites here and a comparator on either basis names a different
    // fallback at position zero.
    const wide = modelOf({
      modelId: modelId('a/wide-thrifty'),
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
      providerCap: 32_000,
    });
    const middling = modelOf({
      modelId: modelId('m/middling'),
      inputRate: 20n,
      outputRate: 40n,
      contextLength: 100_000,
      providerCap: 8000,
    });
    const narrow = modelOf({
      modelId: modelId('z/narrow-dear'),
      inputRate: 400n,
      outputRate: 800n,
      contextLength: 100_000,
      providerCap: 1500,
    });
    const catalog = [wide, middling, narrow];

    // The per-token order's own head, taken from the one implementation that
    // ranks on that basis, so the disagreement is asserted from both orders
    // rather than from a restatement of one.
    expect(classifierEngineOf(catalog)?.modelId).toBe('a/wide-thrifty');
    expect(runnableIds(catalog)).toEqual(['z/narrow-dear', 'm/middling', 'a/wide-thrifty']);
  });

  it('answers a lean payer the same pool as one who can afford anything', () => {
    // 40,000 nano per output token beside a pool whose dearest is 60: its
    // `maxCallCost` clears 20 × the pool median, so `outlier(m)` is what keeps it
    // out of the selectable set — and only a payer who can afford it can show
    // that, which is why the rich run carries the assertion.
    const extreme = modelOf({
      modelId: modelId('q/extreme'),
      inputRate: 20_000n,
      outputRate: 40_000n,
      contextLength: 100_000,
      providerCap: 8000,
    });
    const catalog = [EXPENSIVE, MIDDLE, CHEAPEST, extreme];
    const rich = turnFor(catalog, 10n ** 15n);
    const lean = turnFor(catalog, 4_000_000n);

    // Two genuinely different runs, or the equality below would prove nothing:
    // the lean payer's ceilings are money-bound where the rich payer's sit on the
    // provider cap, and the priced holds differ by that much.
    const ceilingOf = (result: CoreResult, id: string): number | undefined =>
      result.optionSet.all.find((entry) => entry.modelId === id)?.ceilingTokens;
    expect([ceilingOf(rich, 'a/expensive'), ceilingOf(lean, 'a/expensive')]).toEqual([8000, 2365]);
    expect([rich.totalNanoUsd, lean.totalNanoUsd]).toEqual([12_874_264n, 3_999_139n]);

    // `maxCallCost(m)` prices the physical cap, never what the money buys, so the
    // pool and its order are reproducible from the catalog and the prompt alone.
    // A funding term in it collapses every sample toward one clamped value and
    // the order falls back to the identifier tiebreak — which these ids reverse.
    expect(runnableIdsOf(lean)).toEqual(runnableIdsOf(rich));
    expect(runnableIdsOf(rich)).toEqual(['z/cheap', 'm/middle', 'a/expensive']);
    const extremeRow = rich.optionSet.all.find((entry) => entry.modelId === 'q/extreme');
    expect(extremeRow?.availability).toEqual({ available: true });
  });
});
