import { describe, expect, it } from 'vitest';
import { getTurnOptions } from '../turn/turn-options.ts';
import { modelId } from '../model/model-id.ts';
import { poolModelFromWire } from '../model/wire-pool-row.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { PREMIUM_RECENCY_MS } from '../money/premium.ts';
import { ASSISTANT_FRAMING_MAX_CHARS } from '../../assistant-text/grammar.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { WEB_SEARCH_RESULT_MAX_CHARS, toolLoopBound } from '../tool-loop.ts';
import { toolCallBillableNano } from './tool-pricing.ts';
import { textTurnBudget } from './text-turn-budget.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { TextTurnBudget, TextTurnBudgetInput } from './text-turn-budget.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { PromptBasis, TurnOptions } from '../turn/turn-types.ts';
import type { Model } from '../../schemas/api/models.ts';

/** The framing allowance every persisting answer reserves, at 300 nano per character. */
const FRAMING_NANO = BigInt(ASSISTANT_FRAMING_MAX_CHARS) * 300n;

/** A served text row at the given billable nano rates. */
function textRow(overrides: Partial<Model> = {}): Model {
  return {
    id: 'vendor/base',
    name: 'Vendor Base',
    provider: 'vendor',
    modality: 'text',
    contextLength: 128_000,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
    description: 'a text model',
    supportedParameters: [],
    // Released at the epoch: the producer projects only a dated row.
    created: 0,
    ...overrides,
  };
}

/**
 * Billable nano rates: $0.00001 input, $0.00003 output per token, held at
 * their ceilings, 12,500 and 37,500 nano.
 */
const model = textRow();

/** The Smart Model row the catalog serves, priced at its pool's cheapest rates. */
const smartRow = textRow({ id: 'smart-model', isSmartModel: true });

function input(overrides: Partial<TextTurnBudgetInput> = {}): TextTurnBudgetInput {
  return {
    models: [model],
    turnOptions: undefined,
    promptChars: 4000,
    inputChars: 4000,
    payerTier: 'paid',
    payerSpendableNanoUsd: 10_500_000_000n,
    webSearch: false,
    reasoningBudgetTokens: 0,
    loopEffort: undefined,
    ...overrides,
  };
}

/** A budget whose answer figures are priced. */
type AnsweredBudget = TextTurnBudget & {
  readonly maxOutputTokens: number;
  readonly maxAnswerTokens: number;
};

/** The budget of a turn whose answer is priced. */
function budgetOf(budgetInput: TextTurnBudgetInput): AnsweredBudget {
  const budget = textTurnBudget(budgetInput);
  if (budget === undefined) throw new Error('expected a priced turn');
  const { maxOutputTokens, maxAnswerTokens } = budget;
  if (maxOutputTokens === undefined || maxAnswerTokens === undefined) {
    throw new Error('expected a priced answer');
  }
  return { ...budget, maxOutputTokens, maxAnswerTokens };
}

/** The budget of a turn, its answer figures possibly still unpriced. */
function pendingOf(budgetInput: TextTurnBudgetInput): TextTurnBudget {
  const budget = textTurnBudget(budgetInput);
  if (budget === undefined) throw new Error('expected a budget');
  return budget;
}

/**
 * The turn producer's pair for the composer's selection over `catalog`: the
 * pinned rows by id, the Smart slot on, the prompt split as the composer
 * measures it. A pool too small for a price percentile, released at the epoch,
 * so no premium leg confounds the money verdict.
 */
function slotOptions(args: {
  readonly catalog: readonly Model[];
  readonly pinned: readonly Model[];
  readonly promptChars: number;
  readonly inputChars: number;
  readonly spendable: bigint;
  readonly webSearch?: boolean;
  readonly effort?: 'high';
}): TurnOptions {
  const models = args.catalog.flatMap((row) => poolModelFromWire(row) ?? []);
  const pinnedIds = args.pinned.map((row) => modelId(row.id));
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(args.spendable),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    {
      systemChars: 0,
      instructionChars: 0,
      historyChars: args.promptChars - args.inputChars,
      inputChars: args.inputChars,
      attachmentBytes: 0,
    },
    {
      answerSources: { models: pinnedIds, smartSlot: true },
      modality: 'text',
      pinned: args.effort === undefined ? {} : { effort: args.effort },
      webSearch: args.webSearch === true,
    },
    { models, nowMs: PREMIUM_RECENCY_MS }
  );
}

describe('textTurnBudget', () => {
  it('refuses a turn with no selected model rather than answering any figure', () => {
    // A zero here is indistinguishable from a priced turn that funds nothing.
    expect(() => textTurnBudget(input({ models: [] }))).toThrow(
      /textTurnBudget: a turn with no selected model is unpriceable/
    );
  });

  it('estimates input tokens at 3 chars per token, the same for every payer', () => {
    // 4,000 prompt chars / 3, rounded up.
    expect(budgetOf(input({ payerTier: 'paid' })).estimatedInputTokens).toBe(1334);
    expect(budgetOf(input({ payerTier: 'free' })).estimatedInputTokens).toBe(1334);
  });

  it('funds the minimum answer exactly at the fixed terms plus that answer', () => {
    // fixed = input tokens x input rate + input chars x char storage + framing;
    // variable = output rate + 5 stored chars per output token x char storage,
    // over the 1000-token minimum answer, each rate at its ceiling.
    const fixed = 1334n * 12_500n + 4000n * 300n + FRAMING_NANO;
    const variableRate = 37_500n + 5n * 300n;
    const threshold = fixed + 1000n * variableRate;

    expect(budgetOf(input({ payerSpendableNanoUsd: threshold })).maxOutputTokens).toBe(1000);
    expect(budgetOf(input({ payerSpendableNanoUsd: threshold - 1n })).maxOutputTokens).toBe(0);
  });

  it('prices input storage over the new message alone, never the assembled prompt', () => {
    // 4,000 prompt characters carrying a 400-character new message. The input
    // TOKEN leg still prices the whole prompt — the provider receives all of it
    // — while storage prices what the turn newly stores.
    const fixed = 1334n * 12_500n + 400n * 300n + FRAMING_NANO;
    const variableRate = 37_500n + 5n * 300n;
    const payerSpendableNanoUsd = fixed + 1000n * variableRate;

    expect(
      budgetOf(input({ promptChars: 4000, inputChars: 400, payerSpendableNanoUsd })).maxOutputTokens
    ).toBe(1000);
    expect(
      budgetOf(input({ promptChars: 4000, inputChars: 4000, payerSpendableNanoUsd }))
        .maxOutputTokens
    ).toBe(0);
  });

  it('funds more output tokens as the payer spendable rises', () => {
    const lean = budgetOf(input({ payerSpendableNanoUsd: 1_500_000_000n }));
    const flush = budgetOf(input({ payerSpendableNanoUsd: 2_000_000_000n }));

    expect(flush.maxOutputTokens).toBeGreaterThan(lean.maxOutputTokens);
  });

  it('funds nothing when the payer spendable is exhausted', () => {
    expect(budgetOf(input({ payerSpendableNanoUsd: 0n })).maxOutputTokens).toBe(0);
  });

  it('sizes a trial turn from its fixed ceiling, never from a served figure', () => {
    // The trial has no funding door, so a served number cannot reach it: the
    // same fixed ceiling answers whatever spendable is handed in. The rates are
    // ones a 1c ceiling can actually fund, so the arm is pinned by what it
    // funds rather than by a zero both readings would share.
    const trial = {
      payerTier: 'trial',
      promptChars: 200,
      models: [textRow({ pricing: { inputPerToken: '100', outputPerToken: '300' } })],
    } as const;
    const withZero = budgetOf(input({ ...trial, payerSpendableNanoUsd: 0n }));
    const withPlenty = budgetOf(input({ ...trial, payerSpendableNanoUsd: 10_000_000_000n }));

    expect(withZero.maxOutputTokens).toBeGreaterThan(0);
    expect(withPlenty.maxOutputTokens).toBe(withZero.maxOutputTokens);
  });

  it("sizes a guest turn from the payer's served spendable, not a fixed ceiling", () => {
    // A link guest HAS a funding door — the owner's — so the served figure is
    // exactly what reaches the solve.
    expect(budgetOf(input({ payerTier: 'guest', payerSpendableNanoUsd: 0n })).maxOutputTokens).toBe(
      0
    );
    expect(
      budgetOf(input({ payerTier: 'guest', payerSpendableNanoUsd: 20_000_000_000n }))
        .maxOutputTokens
    ).toBeGreaterThan(
      budgetOf(input({ payerTier: 'guest', payerSpendableNanoUsd: 10_000_000_000n }))
        .maxOutputTokens
    );
  });

  it("prices a searching model's whole tool loop into the answer it funds", () => {
    // 1,334 prompt tokens, 11 steps for 10 calls, results of ceil(6,000 / 3)
    // tokens. The prompt rides every step, every step's output and its storage
    // ride the minimum answer, the model's own earlier output is re-sent 55
    // answers' worth, each call's result is re-sent on 10 steps, and the 10
    // tool-carrying steps each send the tool-use overhead.
    const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
    const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
    const fixed =
      11n * 1334n * 12_500n +
      10n * 10n * resultTokens * 12_500n +
      10n * overheadTokens * 12_500n +
      10n * toolCallBillableNano('webSearch') +
      BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n +
      FRAMING_NANO +
      4000n * 300n;
    const variableRate = 11n * (37_500n + 5n * 300n) + 55n * 12_500n;
    const threshold = fixed + 1000n * variableRate;

    expect(
      budgetOf(input({ webSearch: true, payerSpendableNanoUsd: threshold })).maxOutputTokens
    ).toBe(1000);
    expect(
      budgetOf(input({ webSearch: true, payerSpendableNanoUsd: threshold - 1n })).maxOutputTokens
    ).toBe(0);
  });

  it('prices a searching turn`s loop at the loop effort it is handed', () => {
    const low = budgetOf(input({ webSearch: true, loopEffort: 'low' }));
    const high = budgetOf(input({ webSearch: true, loopEffort: 'high' }));
    expect(low.maxOutputTokens).toBeGreaterThan(high.maxOutputTokens);
  });

  it('prices the ceiling loop when no loop effort is handed', () => {
    expect(budgetOf(input({ webSearch: true, loopEffort: 'max' }))).toEqual(
      budgetOf(input({ webSearch: true }))
    );
  });

  it('leaves a turn with no tool alike at every loop effort', () => {
    expect(budgetOf(input({ loopEffort: 'off' }))).toEqual(budgetOf(input({ loopEffort: 'max' })));
  });

  it('reserves nothing for the Smart slot, whose node cannot carry the search tool', () => {
    const slotOnly = (webSearch: boolean): TextTurnBudget =>
      budgetOf(
        input({
          models: [smartRow],
          webSearch,
          turnOptions: slotOptions({
            catalog: [model],
            pinned: [],
            promptChars: 4000,
            inputChars: 4000,
            spendable: 10_500_000_000n,
            webSearch,
          }),
        })
      );

    expect(slotOnly(true)).toEqual(slotOnly(false));
  });

  it('prices the loop on a mixed turn’s named sibling and not on the slot beside it', () => {
    const candidate = textRow({ id: 'vendor/candidate', maxOutputTokens: 4_000_000 });
    const named = textRow({ maxOutputTokens: 4_000_000 });
    const mixed = (webSearch: boolean): number =>
      budgetOf(
        input({
          models: [named, smartRow],
          webSearch,
          turnOptions: slotOptions({
            catalog: [named, candidate],
            pinned: [named],
            promptChars: 4000,
            inputChars: 4000,
            spendable: 10_500_000_000n,
            webSearch,
          }),
        })
      ).maxOutputTokens;
    const bothNamedSearching = budgetOf(
      input({ models: [named, candidate], webSearch: true })
    ).maxOutputTokens;

    // Below the same turn without search: the named sibling carries the loop.
    expect(mixed(true)).toBeLessThan(mixed(false));
    // Above two named siblings searching: the slot beside it carries none.
    expect(mixed(true)).toBeGreaterThan(bothNamedSearching);
  });

  it('leaves the funded pool minus the reasoning budget for the answer', () => {
    // Funding chosen so the pool solves to exactly 34,000 tokens: fixed is
    // 1334 input tokens x 12,500 plus 4000 chars x 300 storage plus the framing
    // allowance, and the variable rate is 37,500 + 5 x 300.
    const budget = budgetOf(
      input({ payerSpendableNanoUsd: 1_343_875_000n + FRAMING_NANO, reasoningBudgetTokens: 32_768 })
    );

    expect(budget.maxOutputTokens).toBe(34_000);
    expect(budget.maxAnswerTokens).toBe(1232);
  });

  it('leaves no answer tokens when the reasoning budget exceeds the funded pool', () => {
    const budget = budgetOf(
      input({ payerSpendableNanoUsd: 1_051_600_000n, reasoningBudgetTokens: 40_000 })
    );

    expect(budget.maxAnswerTokens).toBe(0);
  });

  it('prices a zero reasoning budget identically to a reasoning-free turn', () => {
    expect(budgetOf(input({ reasoningBudgetTokens: 0 }))).toEqual(budgetOf(input()));
  });

  it('refuses a negative prompt character count', () => {
    expect(() => textTurnBudget(input({ promptChars: -100 }))).toThrow(
      /inputTokensOf: chars must be a non-negative integer/
    );
  });

  it('refuses a fractional prompt character count', () => {
    expect(() => textTurnBudget(input({ promptChars: 2.5 }))).toThrow(
      /inputTokensOf: chars must be a non-negative integer/
    );
  });

  it('refuses a negative new-message character count', () => {
    expect(() => textTurnBudget(input({ inputChars: -1 }))).toThrow(
      /textTurnBudget: inputChars must be a non-negative integer/
    );
  });

  it('refuses a fractional new-message character count', () => {
    expect(() => textTurnBudget(input({ inputChars: 1.5 }))).toThrow(
      /textTurnBudget: inputChars must be a non-negative integer/
    );
  });

  it('returns the answer size and context fill, and no price for a text turn', () => {
    expect(Object.keys(budgetOf(input())).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'capacityPercent',
      'currentUsage',
      'estimatedInputTokens',
      'maxAnswerTokens',
      'maxOutputTokens',
    ]);
  });

  it('meters capacity against the most restrictive selected context length', () => {
    const budget = budgetOf(input({ models: [model, textRow({ contextLength: 8000 })] }));

    // Capacity is tier-independent: 3 chars/token plus the minimum answer.
    expect(budget.currentUsage).toBe(1334 + 1000);
    expect(budget.capacityPercent).toBe((2334 / 8000) * 100);
  });
});

/**
 * The composer preview and the send gate are two producers over one turn:
 * `textTurnBudget` sizes the answer a user sees while typing, and
 * `getTurnOptions` decides whether that send is admitted. They read the prompt
 * in different shapes — a pair of counts here, a component basis there — so
 * nothing but a case comparing them catches the two drifting apart, and a
 * preview that funds no answer where the gate admits one understates what the
 * payer's funds can in fact buy.
 */
describe('the composer preview against the send gate', () => {
  /** 4,000 prompt characters of which 400 are the message being composed. */
  const SPLIT_BASIS: PromptBasis = {
    systemChars: 1500,
    instructionChars: 100,
    historyChars: 2000,
    inputChars: 400,
    attachmentBytes: 0,
  };

  /** The same rates the preview prices, as the gate's catalog projection. */
  const GATE_MODEL: PriceableModel = {
    modelId: modelId('vendor/base'),
    pricing: tokenPricingFixture({
      input: nanoUSD(10_000n),
      output: nanoUSD(30_000n),
    }),
    contextLength: 128_000,
    providerCap: 8000,
    releasedAtMs: 0,
    reasoning: undefined,
  };

  /** The least funding that buys the 1000-token minimum answer at these rates' ceilings. */
  const THRESHOLD_NANO_USD =
    1334n * 12_500n +
    BigInt(SPLIT_BASIS.inputChars) * 300n +
    FRAMING_NANO +
    1000n * (37_500n + 5n * 300n);

  function previewFundsAt(fundingNanoUsd: bigint): boolean {
    return (
      budgetOf(
        input({
          promptChars: 4000,
          inputChars: SPLIT_BASIS.inputChars,
          payerSpendableNanoUsd: fundingNanoUsd,
        })
      ).maxOutputTokens > 0
    );
  }

  function sendableAt(fundingNanoUsd: bigint): boolean {
    return getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(fundingNanoUsd),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      SPLIT_BASIS,
      {
        answerSources: { models: [GATE_MODEL.modelId], smartSlot: false },
        modality: 'text',
        pinned: {},
        webSearch: false,
      },
      // A pool too small to carry a price percentile, released at the epoch, so
      // no premium leg confounds the money verdict being compared.
      { models: [GATE_MODEL], nowMs: PREMIUM_RECENCY_MS }
    ).admissible.sendable;
  }

  it('previews an answer at the funding the send gate admits', () => {
    expect(previewFundsAt(THRESHOLD_NANO_USD)).toBe(true);
    expect(sendableAt(THRESHOLD_NANO_USD)).toBe(true);
  });

  it('previews no answer one nano below, where the send gate refuses', () => {
    expect(previewFundsAt(THRESHOLD_NANO_USD - 1n)).toBe(false);
    expect(sendableAt(THRESHOLD_NANO_USD - 1n)).toBe(false);
  });
});

describe('textTurnBudget on a model with a long-context rate', () => {
  /** Sonnet 4.5's anchor: base rates, and dearer rates once a request passes 200,000 prompt tokens. */
  const tieredSonnet = textRow({
    id: 'vendor/sonnet',
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerToken: '3450',
      outputPerToken: '17250',
      longContextRates: [
        { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
      ],
    },
  });

  it('offers the cap the server fits for an 880,000-character history at the long-context rate', () => {
    // 880,000 characters are 293,334 prompt tokens, past the 200,000 threshold.
    // The server holds a 40,000-token answer at the tier's ceiling, 293,334 ×
    // 8,625 + 40,000 × (32,344 + 1,500 output storage) + 640 framing and 88 new
    // characters × 300, 3,883,984,150 nano, so that funding fits exactly 40,000
    // tokens.
    const budget = budgetOf(
      input({
        models: [tieredSonnet],
        promptChars: 880_000,
        inputChars: 88,
        payerSpendableNanoUsd: 3_883_984_150n,
      })
    );

    expect(budget.maxOutputTokens).toBe(40_000);
  });
});

describe('textTurnBudget on the Smart slot', () => {
  /** A Sonnet-priced candidate whose rates rise once a request passes 200,000 prompt tokens. */
  const tieredCandidate = textRow({
    id: 'vendor/sonnet',
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerToken: '3450',
      outputPerToken: '17250',
      longContextRates: [
        { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
      ],
    },
  });
  /** The Smart row the catalog serves over that candidate: its base rates, no long-context rate. */
  const smartOverTiered = textRow({
    id: 'smart-model',
    isSmartModel: true,
    contextLength: 1_000_000,
    pricing: { inputPerToken: '3450', outputPerToken: '17250' },
  });

  it('funds the answer its candidate funds at the long-context rate an 880,000-character history reaches', () => {
    // The synthetic row's base rates alone fund 113,541 tokens; the candidate,
    // priced at the rate 293,334 prompt tokens reach, funds 40,000.
    const budget = budgetOf(
      input({
        models: [smartOverTiered],
        promptChars: 880_000,
        inputChars: 88,
        payerSpendableNanoUsd: 3_883_984_150n,
        turnOptions: slotOptions({
          catalog: [tieredCandidate],
          pinned: [],
          promptChars: 880_000,
          inputChars: 88,
          spendable: 3_883_984_150n,
        }),
      })
    );

    expect(budget.maxOutputTokens).toBe(40_000);
  });

  describe('beside a cheap pinned sibling', () => {
    const cheapPinned = textRow({
      id: 'vendor/cheap',
      contextLength: 200_000,
      maxOutputTokens: 200_000,
      pricing: { inputPerToken: '100', outputPerToken: '400' },
    });
    const dearer = textRow({
      id: 'vendor/dearer',
      contextLength: 200_000,
      maxOutputTokens: 200_000,
      pricing: { inputPerToken: '3000', outputPerToken: '15000' },
    });
    /** Cheaper still, but its context cannot hold the 1,334-token prompt. */
    const shortContext = textRow({
      id: 'vendor/short',
      contextLength: 1000,
      maxOutputTokens: 1000,
      pricing: { inputPerToken: '10', outputPerToken: '40' },
    });
    const smartSlot = textRow({
      id: 'smart-model',
      isSmartModel: true,
      contextLength: 200_000,
      pricing: { inputPerToken: '10', outputPerToken: '40' },
    });

    function slotFigure(catalog: readonly Model[]): number {
      return budgetOf(
        input({
          models: [cheapPinned, smartSlot],
          promptChars: 4000,
          inputChars: 4000,
          payerSpendableNanoUsd: 200_000_000n,
          turnOptions: slotOptions({
            catalog,
            pinned: [cheapPinned],
            promptChars: 4000,
            inputChars: 4000,
            spendable: 200_000_000n,
          }),
        })
      ).maxOutputTokens;
    }

    it('funds the answer the one candidate the slot can resolve to funds beside it', () => {
      // The pinned sibling is not a candidate, so the only arrangement is the
      // pinned sibling with the dearer model, which funds 8,685 tokens.
      expect(slotFigure([cheapPinned, dearer])).toBe(8685);
    });

    it('takes no figure from the pinned sibling or from a row whose context cannot hold the prompt', () => {
      // Neither is an arrangement the slot can run: the figure stays the dearer
      // model's, 8,679 once the short row joins the classifier's pool.
      expect(slotFigure([cheapPinned, dearer, shortContext])).toBe(8679);
    });
  });

  it('funds no answer when the producer refuses the turn', () => {
    const budget = budgetOf(
      input({
        models: [smartRow],
        payerSpendableNanoUsd: 0n,
        turnOptions: slotOptions({
          catalog: [model],
          pinned: [],
          promptChars: 4000,
          inputChars: 4000,
          spendable: 0n,
        }),
      })
    );

    expect(budget.maxOutputTokens).toBe(0);
  });

  it('follows a refusal that leaves the candidate a ceiling, rather than reading the ceiling', () => {
    // A pinned effort the model does not offer refuses the turn while the
    // candidate's row still carries its 4,000-token ceiling.
    const capped = textRow({ id: 'vendor/capped', maxOutputTokens: 4000 });
    const budget = budgetOf(
      input({
        models: [smartRow],
        turnOptions: slotOptions({
          catalog: [capped],
          pinned: [],
          promptChars: 4000,
          inputChars: 4000,
          spendable: 10_500_000_000n,
          effort: 'high',
        }),
      })
    );

    expect(budget.maxOutputTokens).toBe(0);
  });

  it('reads only the candidates the slot can run, never an outlier the picker still lists', () => {
    // Five models capped at 4,000 tokens, and one far dearer model capped at
    // 300,000 that the outlier rule keeps out of the classifier's pool.
    const capped = [1, 2, 3, 4, 5].map((index) =>
      textRow({
        id: `vendor/capped-${String(index)}`,
        contextLength: 400_000,
        maxOutputTokens: 4000,
        pricing: { inputPerToken: '1000', outputPerToken: '3000' },
      })
    );
    const outlier = textRow({
      id: 'vendor/outlier',
      contextLength: 400_000,
      maxOutputTokens: 300_000,
      pricing: { inputPerToken: '300000', outputPerToken: '900000' },
    });
    const spendable = 1_000_000_000_000n;
    const budget = budgetOf(
      input({
        models: [smartRow],
        payerSpendableNanoUsd: spendable,
        turnOptions: slotOptions({
          catalog: [...capped, outlier],
          pinned: [],
          promptChars: 4000,
          inputChars: 4000,
          spendable,
        }),
      })
    );

    expect(budget.maxOutputTokens).toBe(4000);
  });

  it('leaves the Smart slot’s answer unpriced while the producer has not answered', () => {
    const budget = pendingOf(input({ models: [smartRow], turnOptions: undefined }));

    expect([budget.maxOutputTokens, budget.maxAnswerTokens]).toEqual([undefined, undefined]);
  });

  it('keeps a Smart-slot turn’s capacity while the producer has not answered', () => {
    const named = budgetOf(input({ models: [model] }));
    const slot = pendingOf(input({ models: [smartRow], turnOptions: undefined }));

    expect([slot.currentUsage, slot.capacityPercent]).toEqual([
      named.currentUsage,
      named.capacityPercent,
    ]);
  });
});

describe('textTurnBudget on a selection with no price', () => {
  it('answers no budget for a selected row that serves only one rate', () => {
    const halfPriced = textRow({ pricing: { inputPerToken: '10000' } });

    expect(textTurnBudget(input({ models: [model, halfPriced] }))).toBeUndefined();
  });

  it('answers no budget for a selected media row', () => {
    const image = textRow({
      modality: 'image',
      contextLength: 0,
      pricing: { perImage: '40000000', dearestPerImage: '40000000' },
    });

    expect(textTurnBudget(input({ models: [image] }))).toBeUndefined();
  });
});
