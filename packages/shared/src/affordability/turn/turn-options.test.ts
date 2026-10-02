/**
 * The one producer. Called once, with the composed basis; it substitutes the
 * empty basis for the `affordable` pass itself, so a prompt-dependent floor and
 * a hold-blind send gate are both unobtainable rather than merely discouraged.
 */

import { describe, expect, it, vi } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { ModelPricingSchema } from '../price/schedule.ts';
import { tokenPricingOf } from '../price/wire.ts';
import { toolCallBillableNano } from '../estimate/tool-pricing.ts';
import { WEB_SEARCH_RESULT_MAX_CHARS, toolLoopBound } from '../tool-loop.ts';
import { getTurnOptions } from './turn-options.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

const spy = vi.hoisted(() => ({ record: vi.fn() }));

// The core is mocked TRANSPARENTLY — the factory delegates to the real
// implementation and only records its inputs — so every other assertion in this
// file still exercises the production arithmetic.
vi.mock('./turn-core.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./turn-core.ts')>();
  return {
    ...actual,
    evaluateTurn: (input: Parameters<typeof actual.evaluateTurn>[0]) => {
      spy.record(input);
      return actual.evaluateTurn(input);
    },
  };
});

const PLAIN: PriceableModel = {
  modelId: modelId('vendor/plain'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

const LADDER: PriceableModel = {
  modelId: modelId('vendor/ladder'),
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(200n) }),
  contextLength: 200_000,
  providerCap: 64_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** 1,000 prompt characters exactly. */
const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

function fundingOf(
  spendable: bigint,
  held = 0n,
  payerTier: FundingSnapshot['payerTier'] = 'paid'
): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendable),
    heldNanoUsd: nanoUSD(held),
    payerTier,
    payer: 'self',
  } satisfies FundingSnapshot;
}

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

describe('the returned pair', () => {
  it('carries both sets and the hold the turn would place', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    expect(options.affordable.sendable).toBe(true);
    expect(options.admissible.sendable).toBe(true);
    expect(options.holdNanoUsd).toBe(28_556_000n);
  });

  it('carries no hold when the turn cannot start', () => {
    const options = getTurnOptions(fundingOf(1000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    expect(options.admissible.sendable).toBe(false);
    expect(options.holdNanoUsd).toBeUndefined();
  });
});

describe('one call, two evaluations', () => {
  it('runs the core exactly twice per call', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(1_000_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    expect(spy.record).toHaveBeenCalledTimes(2);
  });

  it('supplies the empty basis on the affordable pass and the composed basis on the other', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(1_000_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const [first, second] = spy.record.mock.calls;
    expect(first?.[0]).toMatchObject({ basis: EMPTY_PROMPT_BASIS });
    expect(second?.[0]).toMatchObject({ basis: BASIS });
  });

  it('funds the affordable pass hold-blind and the admissible pass hold-aware', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(600_000_000n, 400_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const [first, second] = spy.record.mock.calls;
    // effectiveBalance = spendable + held; spendable alone gates the send.
    expect(first?.[0]).toMatchObject({ fundingNanoUsd: 1_000_000_000n });
    expect(second?.[0]).toMatchObject({ fundingNanoUsd: 600_000_000n });
  });
});

describe('the floor is prompt-independent', () => {
  it('is byte-identical across a keystroke sweep', () => {
    const funding = fundingOf(30_000_000n);
    const baseline = getTurnOptions(funding, BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    }).affordable;
    for (let typed = 0; typed <= 40; typed += 8) {
      const options = getTurnOptions(
        funding,
        { ...BASIS, inputChars: BASIS.inputChars + typed },
        selectionOf(['vendor/ladder']),
        { models: [LADDER, PLAIN], nowMs: NOW_MS }
      );
      expect(options.affordable).toEqual(baseline);
    }
  });

  it('moves as the prompt grows on the admissible side, which is what makes the byte-identical floor a real pin', () => {
    const funding = fundingOf(30_000_000n);
    const short = getTurnOptions(funding, BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    });
    const long = getTurnOptions(
      funding,
      { ...BASIS, historyChars: 80_000 },
      selectionOf(['vendor/ladder']),
      { models: [LADDER, PLAIN], nowMs: NOW_MS }
    );
    expect(long.admissible).not.toEqual(short.admissible);
    expect(long.affordable).toEqual(short.affordable);
  });
});

describe('the floor is hold-blind', () => {
  it('is byte-identical however much of the balance is reserved', () => {
    const unheld = getTurnOptions(fundingOf(30_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER],
      nowMs: NOW_MS,
    });
    const held = getTurnOptions(
      fundingOf(1_000_000n, 29_000_000n),
      BASIS,
      selectionOf(['vendor/ladder']),
      { models: [LADDER], nowMs: NOW_MS }
    );
    expect(held.affordable).toEqual(unheld.affordable);
    expect(held.admissible).not.toEqual(unheld.admissible);
  });
});

describe('the floor does react to discrete selections', () => {
  it('changes when a dimension is pinned', () => {
    const open = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER],
      nowMs: NOW_MS,
    });
    const pinned = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/ladder'], { pinned: { effort: 'high' } }),
      { models: [LADDER], nowMs: NOW_MS }
    );
    expect(pinned.affordable).not.toEqual(open.affordable);
  });

  it('changes when a sibling is added', () => {
    const solo = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    });
    const pair = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/ladder', 'vendor/plain']),
      { models: [LADDER, PLAIN], nowMs: NOW_MS }
    );
    expect(pair.affordable).not.toEqual(solo.affordable);
  });

  it('changes when the modality changes', () => {
    const text = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const image = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/plain'], { modality: 'image' }),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    expect(image.affordable).not.toEqual(text.affordable);
  });
});

describe('one input ratio and one stored-output ratio', () => {
  it('prices a paid turn at 3 input chars per token and 5 stored chars per output token', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'paid'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 334 input tokens x 1,000 + 8,000 x (2,000 + 1,500) + 30,000 input storage
    // (the 100 new-message characters, not all 1,000 prompt characters) +
    // 192,000 framing (640 characters at 300 nano).
    expect(options.holdNanoUsd).toBe(28_556_000n);
  });

  it('prices a free turn exactly as it prices a paid one', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'free'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    expect(options.holdNanoUsd).toBe(28_556_000n);
  });

  it('rounds the input division up, against the user', () => {
    const partial = getTurnOptions(
      fundingOf(1_000_000_000n),
      { ...BASIS, inputChars: BASIS.inputChars + 1 },
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 1,001 characters fill 333 tokens and part of a 334th, which is held whole:
    // the same 334 input tokens as 1,000 characters, so the one more character
    // adds its own storage and nothing else. Rounding down would hold 333.
    expect(partial.holdNanoUsd).toBe(28_556_000n + 300n);
  });
});

describe('a trial turn never persists', () => {
  it('carries no storage anywhere in its hold', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'trial'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 334 input tokens x 1,000 + 8,000 x 2,000, and nothing else.
    expect(options.holdNanoUsd).toBe(16_334_000n);
  });
});

describe('cache reads', () => {
  it('are not projected into the money layer at all, so nothing can price them cheaply', () => {
    const parsed = ModelPricingSchema.parse({
      kind: 'tokens',
      anchor: { base: { input: '1000', output: '2000', cachedInput: '1' }, tiers: [] },
    });
    expect(tokenPricingOf(parsed)?.anchor.base).toEqual({ input: 1000n, output: 2000n });
  });

  it('price at the full input rate in the produced hold', () => {
    const cached: PriceableModel = {
      ...PLAIN,
      pricing: tokenPricingFixture({ input: 1000n, output: 2000n }),
    };
    const options = getTurnOptions(
      fundingOf(1_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [cached], nowMs: NOW_MS }
    );
    // 334 input tokens at the FULL 1,000-nano rate, not the 1-nano cached rate.
    expect(options.holdNanoUsd).toBe(28_556_000n);
  });
});

describe('web search', () => {
  it('prices each of three searching siblings its own tool loop', () => {
    const models: readonly PriceableModel[] = [
      PLAIN,
      { ...PLAIN, modelId: modelId('vendor/plain-b') },
      { ...PLAIN, modelId: modelId('vendor/plain-c') },
    ];
    const withoutSearch = getTurnOptions(
      fundingOf(10_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain', 'vendor/plain-b', 'vendor/plain-c']),
      { models: models, nowMs: NOW_MS }
    );
    const withSearch = getTurnOptions(
      fundingOf(10_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain', 'vendor/plain-b', 'vendor/plain-c'], { webSearch: true }),
      { models: models, nowMs: NOW_MS }
    );
    // Each sibling answers at its 8,000-token cap, over 334 prompt tokens,
    // and its loop takes 10 more steps than a plain answer: 10 more prompts, each
    // of 10 calls' results re-sent on 10 later steps, the tool-use overhead on
    // the 10 tool-carrying steps, 10 call fees and the stored search rows, plus
    // 10 more steps of output and its storage and the model's own output re-sent
    // 55 times.
    const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
    const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
    const loopExtra =
      10n * 334n * 1000n +
      10n * 10n * resultTokens * 1000n +
      10n * overheadTokens * 1000n +
      10n * toolCallBillableNano('webSearch') +
      BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n +
      8000n * (10n * (2000n + 1500n) + 55n * 1000n);
    expect((withSearch.holdNanoUsd ?? 0n) - (withoutSearch.holdNanoUsd ?? 0n)).toBe(3n * loopExtra);
  });
});

describe('an open effort axis funded for Min alone', () => {
  /**
   * The send gate every client surface reads, on a lone pinned model with a
   * real ladder funded well enough for Min and for no rung above it.
   *
   * A laddered model that answers with no reasoning wire is a legal turn, so
   * the gate grades this turn on its cheapest corner — Min — and sends. The
   * ladder narrows which rungs the menu offers; it never withholds the send.
   */
  const options = (spendable: bigint): ReturnType<typeof getTurnOptions> =>
    getTurnOptions(fundingOf(spendable), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER],
      nowMs: NOW_MS,
    });

  /** Funds a Min turn and nothing above it — asserted below, never assumed. */
  const MIN_ONLY_FUNDING = 3_000_000n;

  it('grades Min available and every rung above it out of reach', () => {
    const effort = options(MIN_ONLY_FUNDING).admissible.turnDimensions.find(
      (dimension) => dimension.dimensionId === 'effort'
    );
    expect(
      effort?.options.map((option) => [option.optionId, option.availability.available])
    ).toEqual([
      ['off', true],
      ['low', false],
      ['medium', false],
      ['high', false],
    ]);
  });

  it('sends anyway, because Min alone is an answer the turn can run', () => {
    expect(options(MIN_ONLY_FUNDING).admissible.sendable).toBe(true);
  });

  it('sends the same turn at higher funding', () => {
    // The upper end of the same axis, carried by the sibling that grades every
    // rung above Min out of reach at MIN_ONLY_FUNDING: funding the ladder does
    // not change the verdict, so nothing here is gating on the ladder.
    const funded = options(20_000_000n).admissible;
    expect(funded.sendable).toBe(true);
  });
});
