/**
 * `minTurnCost` pinned BY AMOUNT, so the composition cannot lose a term
 * silently, and BY THE BICONDITIONAL it exists to satisfy — funding equal
 * to it makes the turn sendable, funding one nano below it does not. The second
 * is what makes it the RIGHT threshold rather than merely a smaller one: a payer
 * decision taken on a number that clears the corner but not the hold admits a
 * turn admission then refuses, forever.
 *
 * The biconditional is asked of `getTurnOptions`, so it is an assertion about
 * the ceiling solve AS PRODUCTION COMPOSES IT. Asking the arithmetic primitives
 * directly would pin the same terms in a second arrangement of this file's own
 * making, which stays green through any change to the real one.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { minTurnCostNanoUsd } from './min-turn-cost.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from './nano-usd.ts';
import { PREMIUM_RECENCY_MS } from './premium.ts';
import { getTurnOptions } from '../turn/turn-options.ts';
import { ASSISTANT_FRAMING_MAX_CHARS } from '../../assistant-text/grammar.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { toolCallBillableNano } from '../estimate/tool-pricing.ts';
import { ceilingOf } from '../price/schedule.ts';
import { WEB_SEARCH_RESULT_MAX_CHARS, toolCallCapFor, toolLoopBound } from '../tool-loop.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { MinTurnCostInput, MinTurnCostSibling } from './min-turn-cost.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { NonEmpty, PromptBasis, TurnOptions } from '../turn/turn-types.ts';
import type { UserTier } from './tiers.ts';

/**
 * 100 nano per input token, 200 per output token — round numbers on purpose,
 * held at their ceilings: 125 and 250.
 */
const MODEL: PriceableModel = {
  modelId: modelId('vendor/base'),
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(200n) }),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

/**
 * The same rates, but reasoning cannot be turned off: `e_min` costs tokens. Its
 * provider cap is wide enough to hold that rung AND a minimum answer — a
 * mandatory-reasoning model whose cap cannot hold both is ineligible at every
 * funding level, which is a capability refusal rather than a money one.
 */
const MANDATORY_MODEL: PriceableModel = {
  ...MODEL,
  modelId: modelId('vendor/mandatory'),
  providerCap: 40_000,
  reasoning: { mandatory: true, supportedEfforts: ['high'] },
};

/** An open ladder the payer can pin at any rung: Min, Low, Mid and High. */
const LADDERED_MODEL: PriceableModel = {
  ...MODEL,
  modelId: modelId('vendor/laddered'),
  providerCap: 40_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** `B(m, e_min)` for {@link MANDATORY_MODEL}: the High rung, under its cap. */
const MANDATORY_REASONING_TOKENS = 32_768;

/** 400 prompt characters: 134 input tokens at 3 characters per token. */
const PROMPT_CHARS = 400;

/** The framing allowance every persisting answer reserves: 640 characters at 300 nano. */
const FRAMING_NANO = BigInt(ASSISTANT_FRAMING_MAX_CHARS) * 300n;

/** A sibling whose node carries no tool. */
function plain(model: PriceableModel): MinTurnCostSibling {
  return { model, tools: [] };
}

/** A sibling whose node carries the web-search tool. */
function searching(model: PriceableModel): MinTurnCostSibling {
  return { model, tools: ['webSearch'] };
}

function inputFor(overrides: Partial<MinTurnCostInput> = {}): MinTurnCostInput {
  return {
    siblings: [plain(MODEL)],
    promptChars: PROMPT_CHARS,
    inputChars: PROMPT_CHARS,
    persists: true,
    classifierReserveNanoUsd: 0n,
    reasoningEffort: 'auto',
    ...overrides,
  };
}

/**
 * What a sibling's search loop of `calls` calls adds over the same sibling
 * answering in one step, at 134 input tokens and the model's ceiling rates:
 * one more prompt per call, every call's result re-sent on each later step,
 * the tool-use overhead on each call's step, the call fees and the stored
 * search rows as fixed terms; one more step of output and its storage per
 * call, and the model's own earlier output re-sent `calls × (calls + 1) / 2`
 * answers' worth, per output token. The ceiling loop is ten calls.
 */
function searchLoopExtra(
  model: PriceableModel,
  calls = 10n
): {
  readonly fixed: bigint;
  readonly perToken: bigint;
} {
  const { input, output } = ceilingOf(model.pricing.anchor).base;
  const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
  const overheadTokens = BigInt(toolLoopBound(['webSearch'], 1).overheadTokens);
  return {
    fixed:
      calls * 134n * input +
      calls * calls * resultTokens * input +
      calls * overheadTokens * input +
      calls * toolCallBillableNano('webSearch') +
      BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n,
    perToken: calls * (output + 5n * 300n) + ((calls * (calls + 1n)) / 2n) * input,
  };
}

/** The calls a sibling's loop may make at the mandatory model's only rung. */
const MANDATORY_LOOP_CALLS = BigInt(toolCallCapFor('high'));

/**
 * The two measured counts as the §Math & Terms basis sees them: the new message
 * in `inputChars` and everything else in `historyChars`, so the components sum
 * to the same total the bound is handed.
 */
function basisOf(input: MinTurnCostInput): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: input.promptChars - input.inputChars,
    inputChars: input.inputChars,
    attachmentBytes: 0,
  };
}

/**
 * The same turn, put through the ONE producer at a given funding number, for a
 * payer at `payerTier`. `admissible` is the set the send gate reads, so a
 * `sendable` verdict here is the verdict production takes.
 *
 * Only the translation lives in this helper, and it carries one obligation the
 * types cannot: the producer derives persistence from the tier
 * (`tier !== 'trial'`), so a case must keep {@link MinTurnCostInput.persists}
 * consistent with its payer tier or the two sides price different turns.
 */
function optionsAt(
  input: MinTurnCostInput,
  fundingNanoUsd: bigint,
  payerTier: UserTier = 'paid'
): TurnOptions {
  const models: NonEmpty<ModelId> = [
    input.siblings[0].model.modelId,
    ...input.siblings.slice(1).map(({ model }) => model.modelId),
  ];
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(fundingNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier,
      payer: 'self',
    },
    basisOf(input),
    {
      answerSources: { models, smartSlot: false },
      modality: 'text',
      pinned:
        input.reasoningEffort === undefined || input.reasoningEffort === 'auto'
          ? {}
          : { effort: input.reasoningEffort },
      // The producer puts the tool on every pinned sibling, so a case carries it
      // on all of its siblings or on none.
      webSearch: input.siblings.some(({ tools }) => tools.length > 0),
    },
    // The pool is the siblings themselves: too small to carry a price
    // threshold, and released at the epoch, so neither premium leg fires and no
    // tier-access refusal is confounded with the money one being pinned.
    { models: input.siblings.map(({ model }) => model), nowMs: PREMIUM_RECENCY_MS }
  );
}

/** The hold the producer would take at that funding, in nano-USD. */
function holdAt(
  input: MinTurnCostInput,
  fundingNanoUsd: bigint,
  payerTier: UserTier = 'paid'
): bigint | undefined {
  const { holdNanoUsd } = optionsAt(input, fundingNanoUsd, payerTier);
  return holdNanoUsd === undefined ? undefined : BigInt(holdNanoUsd);
}

describe('minTurnCostNanoUsd — the eligible corner, by amount', () => {
  it('prices input tokens, input storage, framing and a minimum answer for one model', () => {
    // 400 chars at 3 chars/token = 134 input tokens × 125 nano = 16,750.
    // Input storage: 400 chars × 300 nano = 120,000.
    // Framing: 640 chars × 300 nano = 192,000.
    // Output: 1,000 minimum tokens × (250 provider + 5 chars × 300 storage) = 1,750,000.
    expect(minTurnCostNanoUsd(inputFor())).toBe(2_078_750n);
  });

  it('drops both storage terms on a turn that does not persist', () => {
    // Provider legs only: 16,750 input + 1,000 × 250 output = 266,750.
    expect(minTurnCostNanoUsd(inputFor({ persists: false }))).toBe(266_750n);
  });

  it('adds the classifier reserve as a fixed term', () => {
    expect(minTurnCostNanoUsd(inputFor({ classifierReserveNanoUsd: 7n }))).toBe(2_078_757n);
  });

  it("adds the web-search reservation per sibling when the turn's search tool is on", () => {
    const extra = searchLoopExtra(MODEL);
    expect(minTurnCostNanoUsd(inputFor({ siblings: [searching(MODEL)] }))).toBe(
      2_078_750n + extra.fixed + 1000n * extra.perToken
    );
  });

  it('prices the tool loop’s per-output-token legs at the corner rather than dropping them', () => {
    // The widest corner is the mandatory sibling's, so the loop's per-token legs
    // are priced over its reasoning rung and the minimum answer together. Its one
    // rung is the lowest an open axis can fall to, so the loop is that rung's.
    const corner = BigInt(MANDATORY_REASONING_TOKENS + MINIMUM_OUTPUT_TOKENS);
    const extra = searchLoopExtra(MANDATORY_MODEL, MANDATORY_LOOP_CALLS);
    const tool = minTurnCostNanoUsd(inputFor({ siblings: [searching(MANDATORY_MODEL)] }));
    const toolFree = minTurnCostNanoUsd(inputFor({ siblings: [plain(MANDATORY_MODEL)] }));
    expect(tool - toolFree).toBe(extra.fixed + corner * extra.perToken);
  });

  it('prices the loop on the sibling that carries the tool and on no other', () => {
    // A mixed arrangement: the first sibling's node carries no tool (as the Smart
    // slot's own answer never does), the second's carries the search tool.
    const corner = BigInt(MANDATORY_REASONING_TOKENS + MINIMUM_OUTPUT_TOKENS);
    const extra = searchLoopExtra(MANDATORY_MODEL, MANDATORY_LOOP_CALLS);
    const mixed = minTurnCostNanoUsd(
      inputFor({ siblings: [plain(MODEL), searching(MANDATORY_MODEL)] })
    );
    const toolFree = minTurnCostNanoUsd(
      inputFor({ siblings: [plain(MODEL), plain(MANDATORY_MODEL)] })
    );
    expect(mixed - toolFree).toBe(extra.fixed + corner * extra.perToken);
  });

  it('prices a pinned rung`s own loop, so a searching turn pinned Low costs less than High', () => {
    const low = minTurnCostNanoUsd(
      inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'low' })
    );
    const high = minTurnCostNanoUsd(
      inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'high' })
    );
    expect(low).toBeLessThan(high);
  });

  it('prices an open axis at the lowest rung the siblings offer', () => {
    expect(
      minTurnCostNanoUsd(
        inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'auto' })
      )
    ).toBe(
      minTurnCostNanoUsd(
        inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'off' })
      )
    );
  });

  it('prices the ceiling loop when the send carries no reasoning selection', () => {
    const extra = searchLoopExtra(MODEL);
    expect(
      minTurnCostNanoUsd(inputFor({ siblings: [searching(MODEL)], reasoningEffort: undefined }))
    ).toBe(2_078_750n + extra.fixed + 1000n * extra.perToken);
  });

  it('prices input storage over the new message alone, never the assembled prompt', () => {
    // 4,000 prompt characters carrying a 400-character new message.
    // Input tokens: 4,000 / 3 = 1,334 tokens x 125 nano = 166,750 — the WHOLE
    // prompt, which is what the provider receives.
    // Input storage: 400 x 300 = 120,000 — the new message, which is all a turn
    // newly stores.
    // Framing: 640 x 300 = 192,000.
    // Output: 1,000 minimum tokens x (250 provider + 5 chars x 300 storage) = 1,750,000.
    expect(minTurnCostNanoUsd(inputFor({ promptChars: 4000, inputChars: 400 }))).toBe(2_228_750n);
  });

  it('moves only the storage leg when the same prompt carries a shorter new message', () => {
    const wholePromptIsNew = minTurnCostNanoUsd(inputFor({ promptChars: 4000, inputChars: 4000 }));
    const shortNewMessage = minTurnCostNanoUsd(inputFor({ promptChars: 4000, inputChars: 400 }));

    // Exactly the storage of the 3,600 characters that are no longer new. An
    // input-token leg that narrowed alongside storage would widen this gap.
    expect(wholePromptIsNew - shortNewMessage).toBe(3600n * 300n);
  });

  it('carries no input-storage leg for a turn that stores no new message', () => {
    const storesNothing = minTurnCostNanoUsd(inputFor({ promptChars: 4000, inputChars: 0 }));
    const storesFourHundred = minTurnCostNanoUsd(inputFor({ promptChars: 4000, inputChars: 400 }));

    expect(storesFourHundred - storesNothing).toBe(400n * 300n);
  });

  it('reserves the cheapest reasoning rung a mandatory-reasoning model must spend', () => {
    // `e_min` is the model's lowest offered rung — thinking tokens on top of
    // the 1,000-token minimum answer, both billed at the output rate.
    const corner = BigInt(MANDATORY_REASONING_TOKENS + MINIMUM_OUTPUT_TOKENS);
    expect(minTurnCostNanoUsd(inputFor({ siblings: [plain(MANDATORY_MODEL)] }))).toBe(
      16_750n + 120_000n + FRAMING_NANO + corner * 1750n
    );
  });
});

describe('minTurnCostNanoUsd — the biconditional', () => {
  // The classifier reserve has no case here on purpose: the producer DERIVES it
  // from the catalog and the open dimensions, so no case can hand it one, and
  // handing it a figure this file computed would be the re-composition the
  // biconditional exists to avoid. Its amount is pinned above instead.
  const cases: readonly {
    readonly name: string;
    readonly input: MinTurnCostInput;
    readonly payerTier?: UserTier;
  }[] = [
    { name: 'one model', input: inputFor() },
    {
      name: 'a trial turn, which stores nothing',
      input: inputFor({ persists: false }),
      payerTier: 'trial',
    },
    { name: 'a free-tier payer', input: inputFor(), payerTier: 'free' },
    {
      name: 'a long prompt carrying a short new message',
      input: inputFor({ promptChars: 4000, inputChars: 400 }),
    },
    { name: 'a turn with web search on', input: inputFor({ siblings: [searching(MODEL)] }) },
    {
      name: 'two searching siblings',
      input: inputFor({ siblings: [searching(MODEL), searching(MANDATORY_MODEL)] }),
    },
    {
      name: 'a mandatory-reasoning model',
      input: inputFor({ siblings: [plain(MANDATORY_MODEL)] }),
    },
    {
      name: 'a searching sibling with reasoning off',
      input: inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'off' }),
    },
    {
      name: 'siblings whose cheapest corners differ',
      input: inputFor({ siblings: [plain(MODEL), plain(MANDATORY_MODEL)] }),
    },
  ];

  it.each(cases)('funding equal to it leaves the turn sendable — $name', ({ input, payerTier }) => {
    expect(optionsAt(input, minTurnCostNanoUsd(input), payerTier).admissible.sendable).toBe(true);
  });

  // Asserting the REASON, not merely the refusal: a red that arrives because
  // the prompt is too long or the model's cap is too low would satisfy
  // `sendable === false` while saying nothing about the threshold.
  it.each(cases)('one nano below it refuses for want of money — $name', ({ input, payerTier }) => {
    const set = optionsAt(input, minTurnCostNanoUsd(input) - 1n, payerTier).admissible;
    expect(set.sendable ? 'sendable' : set.refusal).toBe('insufficient_funds');
  });

  it.each(cases)('the hold it buys never exceeds it — $name', ({ input, payerTier }) => {
    const funding = minTurnCostNanoUsd(input);
    expect(holdAt(input, funding, payerTier)).toBeLessThanOrEqual(funding);
  });

  // Under a pin the loop is the pin's while the corner stays the model's cheapest
  // rung, so the bound is a floor the pinned send can never go below rather than
  // its exact boundary: only the refusal half binds.
  const pinnedCases: readonly { readonly name: string; readonly input: MinTurnCostInput }[] = [
    {
      name: 'pinned Low',
      input: inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'low' }),
    },
    {
      name: 'pinned High',
      input: inputFor({ siblings: [searching(LADDERED_MODEL)], reasoningEffort: 'high' }),
    },
  ];

  it.each(pinnedCases)('one nano below it refuses a searching sibling $name', ({ input }) => {
    const set = optionsAt(input, minTurnCostNanoUsd(input) - 1n).admissible;
    expect(set.sendable ? 'sendable' : set.refusal).toBe('insufficient_funds');
  });
});

/**
 * The bound is fed a measured TOTAL while the producer is fed the route's split
 * basis, so the two are not handed the same shape. What the payer decision needs
 * is that funding equal to the bound still SENDS on the basis the route builds —
 * a remainder frozen as owner-funded and then refused at admission is the
 * deterministic refusal `coversTurn` exists to catch — and that is a property of
 * which component the total is carried in: `inputStorage` prices `inputChars`,
 * so a total parked in any other component drops the storage leg out of the
 * bound and puts it below the hold.
 */
describe('the bound against a prompt the producer sees split into components', () => {
  /** Mostly system prompt and history, with a short new message. */
  const SPLIT_BASIS: PromptBasis = {
    systemChars: 1500,
    instructionChars: 100,
    historyChars: 2000,
    inputChars: 400,
    attachmentBytes: 0,
  };
  const TOTAL_CHARS = 4000;

  function splitOptionsAt(fundingNanoUsd: bigint): TurnOptions {
    return getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(fundingNanoUsd),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      SPLIT_BASIS,
      {
        answerSources: { models: [MODEL.modelId], smartSlot: false },
        modality: 'text',
        pinned: {},
        webSearch: false,
      },
      { models: [MODEL], nowMs: PREMIUM_RECENCY_MS }
    );
  }

  it('leaves the turn sendable at exactly the bound', () => {
    const bound = minTurnCostNanoUsd(
      inputFor({ promptChars: TOTAL_CHARS, inputChars: SPLIT_BASIS.inputChars })
    );
    expect(splitOptionsAt(bound).admissible.sendable).toBe(true);
  });

  it('never falls below the hold that send would place', () => {
    const bound = minTurnCostNanoUsd(
      inputFor({ promptChars: TOTAL_CHARS, inputChars: SPLIT_BASIS.inputChars })
    );
    const hold = splitOptionsAt(bound).holdNanoUsd;
    expect(hold === undefined ? 0n : BigInt(hold)).toBeLessThanOrEqual(bound);
  });
});
