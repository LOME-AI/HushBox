/**
 * The arithmetic vocabulary of `docs/BILLING.md` §Math & Terms, pinned BY
 * AMOUNT. A test that checks a term exists satisfies the words and loses the
 * arithmetic, so every assertion here names the number it expects and where the
 * number comes from.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { cheapestEffortOption, EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { dimensionSupportFor } from '../dimensions/derive.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import {
  budgetBuysTokens,
  callCostBasis,
  ceilingTokens,
  contextHeadroomTokens,
  costNanoUsd,
  eligible,
  feasible,
  inputStorageNanoUsd,
  maxCallCostNanoUsd,
  maxCallCostTokens,
  medianMaxCallCostNanoUsd,
  MONEY_SOLVE_CAP_TOKENS,
  outlierModelIds,
  reasoningBudgetTokens,
  requiredCeilingTokens,
  siblingCurve,
  siblingLineItems,
} from './turn-arithmetic.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { toolLoopBound } from '../tool-loop.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { promptCharsOf } from './turn-types.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PromptBasis } from './turn-types.ts';
import type { CallCostBasis, CostContext } from './turn-arithmetic.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ToolLoopBound } from '../tool-loop.ts';

/**
 * 1,000 nano per input token, 2,000 per output token — round numbers on
 * purpose, held at their ceilings: 1,250 and 2,500.
 */
const MODEL: PriceableModel = {
  modelId: modelId('vendor/base'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

/** 1,000 prompt characters exactly. */
const BASIS: PromptBasis = {
  systemChars: 500,
  instructionChars: 100,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

/** One sibling's pricing context at 250 input tokens, no prompt storage. */
function contextAt(persists: boolean, toolLoop?: ToolLoopBound): CostContext {
  return {
    inputTokens: 250,
    inputChars: 0,
    persists,
    ...(toolLoop === undefined ? {} : { toolLoop }),
  };
}

/** `variableRate(m)`: what one more output token costs on the sibling's untiered curve. */
function variableRateOf(context: CostContext): bigint {
  return costNanoUsd(MODEL, 1, context) - costNanoUsd(MODEL, 0, context);
}

/** `fixedCosts`: every sibling's cost at no output, plus the classifier reserve. */
function fixedCostsOf(contexts: readonly CostContext[], classifierReserveNanoUsd: bigint): bigint {
  return contexts.reduce(
    (total, context) => total + costNanoUsd(MODEL, 0, context),
    classifierReserveNanoUsd
  );
}

describe('variableRate(m) — outputRate(m) plus per-token storage when the turn persists', () => {
  it('adds the storage rate per token on a persisting turn: 2,500 + 1,500', () => {
    expect(variableRateOf(contextAt(true))).toBe(4000n);
  });

  it('is the bare output rate when the turn does not persist', () => {
    expect(variableRateOf(contextAt(false))).toBe(2500n);
  });

  it('prices every step’s output and the model’s own re-sent output on a tool loop', () => {
    // Three steps for two calls: 3 × (2,500 + 1,500), plus 3 × 2 / 2 re-sent
    // outputs at the 1,250-nano input rate.
    const loop = toolLoopBound(['webSearch'], 2);
    expect(variableRateOf(contextAt(true, loop))).toBe(3n * 4000n + 3n * 1250n);
  });
});

describe('inputStorageNanoUsd — inputChars × storageRatePerChar, once per turn', () => {
  it('prices the new message alone, never the system prompt or the resent history', () => {
    // BASIS is 500 system + 100 instruction + 300 history + 100 input. Only the
    // 100 new-input characters are stored by this turn: the system prompt never
    // rests at all, and every history character was stored by the turn that
    // wrote it.
    expect(inputStorageNanoUsd(BASIS, true)).toBe(30_000n);
  });

  it('grows with the new message and stands still as the history grows', () => {
    const longerHistory = { ...BASIS, historyChars: BASIS.historyChars + 10_000 };
    const longerMessage = { ...BASIS, inputChars: BASIS.inputChars + 10 };
    expect(inputStorageNanoUsd(longerHistory, true)).toBe(30_000n);
    expect(inputStorageNanoUsd(longerMessage, true)).toBe(33_000n);
  });

  it('is zero when the turn does not persist', () => {
    expect(inputStorageNanoUsd(BASIS, false)).toBe(0n);
  });
});

describe('the input legs price different things and must not be collapsed', () => {
  it('prices input TOKENS over the whole prompt while storage prices the new message', () => {
    // The provider receives the whole assembled prompt, so the token leg is
    // priced over all 1,000 characters; only the storage leg narrows.
    expect(inputTokensOf(promptCharsOf(BASIS))).toBe(334);
    expect(inputStorageNanoUsd(BASIS, true)).toBe(30_000n);
  });

  it('leaves the token leg unmoved when history grows and storage does not follow', () => {
    const longerHistory = { ...BASIS, historyChars: BASIS.historyChars + 400 };
    expect(inputTokensOf(promptCharsOf(longerHistory))).toBe(467);
    expect(inputStorageNanoUsd(longerHistory, true)).toBe(inputStorageNanoUsd(BASIS, true));
  });
});

describe('fixedCosts — the terms that do not scale with output tokens', () => {
  /** A sibling's context at 250 input tokens, carrying `inputChars` of prompt storage. */
  function sibling(inputChars: number, persists = true): CostContext {
    return { inputTokens: 250, inputChars, persists };
  }

  it('sums every sibling’s fixed legs and the classifier reserve', () => {
    // 250 input tokens × 1,250 nano × 2 siblings = 625,000
    //                     + inputStorage 1,000 × 300 = 300,000
    //                     + framing 640 × 300 × 2 siblings = 384,000
    //                     + classifierReserve 7,000
    expect(fixedCostsOf([sibling(1000), sibling(0)], 7000n)).toBe(1_316_000n);
  });

  it('counts input storage exactly once however many siblings share the prompt', () => {
    const one = fixedCostsOf([sibling(1000)], 0n);
    const three = fixedCostsOf([sibling(1000), sibling(0), sibling(0)], 0n);
    expect(one).toBe(804_500n);
    expect(three).toBe(1_813_500n);
    expect(three - one).toBe(2n * (312_500n + 192_000n));
  });

  it('carries no classifier reserve when no classifier runs', () => {
    expect(fixedCostsOf([sibling(0, false)], 0n)).toBe(312_500n);
  });

  it('carries a tool-carrying sibling’s whole fixed loop', () => {
    // Three steps for two calls: the prompt on each step, each call's result
    // re-sent on two later steps, the tool-use overhead on the two tool-carrying
    // steps, two call fees, and the stored search rows.
    const loop = toolLoopBound(['webSearch'], 2);
    expect(fixedCostsOf([contextAt(true, loop)], 0n)).toBe(
      3n * 312_500n +
        2n * 2n * BigInt(loop.resultTokens) * 1250n +
        2n * BigInt(loop.overheadTokens) * 1250n +
        2n * loop.callFeeNano +
        BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n +
        192_000n
    );
  });
});

describe('costNanoUsd — inputTokens × inputRate(m) + tokens × variableRate(m)', () => {
  it('prices a persisting call: 250 × 1,250 + 1,000 × 4,000 + framing', () => {
    expect(costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 0, persists: true })).toBe(
      4_312_500n + 192_000n
    );
  });

  it('drops the storage term when the turn does not persist', () => {
    expect(costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 0, persists: false })).toBe(
      2_812_500n
    );
  });

  it('adds prompt storage for the sibling that carries it: 1,000 chars × 300n', () => {
    expect(costNanoUsd(MODEL, 1000, { inputTokens: 250, inputChars: 1000, persists: true })).toBe(
      4_312_500n + 192_000n + 300_000n
    );
  });

  it('folds the same manifest a surface reads, so an amount and its breakdown cannot disagree', () => {
    const context = { inputTokens: 250, inputChars: 1000, persists: true } as const;
    const items = siblingLineItems(MODEL, context, 0);
    expect(items.map((item) => item.label)).toEqual([
      'text-input-tokens',
      'input-storage',
      'text-output-tokens',
      'output-storage',
      'framing-storage',
    ]);
    expect(costNanoUsd(MODEL, 0, context)).toBe(
      items.reduce((sum, item) => sum + (item.fixedNano ?? 0n), 0n)
    );
  });

  it('carries no storage line item at all when the turn does not persist', () => {
    const items = siblingLineItems(
      MODEL,
      { inputTokens: 250, inputChars: 1000, persists: false },
      0
    );
    expect(items.filter((item) => item.kind === 'storage')).toEqual([]);
  });
});

describe('siblingLineItems — a manifest that does not price', () => {
  // A model always prices; a COUNT does not have to. An unpriceable manifest
  // reaching an empty item list would price the whole call at zero — every leg
  // of it — so the refusal is the one alternative to charging nothing.
  it('refuses a count the estimator rejects rather than pricing the call at zero', () => {
    const context = { inputTokens: -1, inputChars: 0, persists: true } as const;
    expect(() => siblingLineItems(MODEL, context, 0)).toThrow(RangeError);
  });

  it('refuses through every term that reads the manifest, not only the item list', () => {
    const context = { inputTokens: -1, inputChars: 0, persists: true } as const;
    expect(() => costNanoUsd(MODEL, 1000, context)).toThrow(RangeError);
    expect(() => maxCallCostNanoUsd(MODEL, callCostBasis(-1, true))).toThrow(RangeError);
  });
});

describe('contextHeadroomTokens — contextLength(m) − inputTokens', () => {
  it('subtracts the prompt from the context window', () => {
    expect(contextHeadroomTokens(MODEL, 250)).toBe(99_750);
  });

  it('never reports negative headroom for a prompt past the window', () => {
    expect(contextHeadroomTokens(MODEL, 250_000)).toBe(0);
  });
});

describe('budgetBuysTokens — floor((funding − fixedCosts) / Σ variableRate)', () => {
  /**
   * A sibling stored at 1,000 / 2,600, whose curve holds 1,250,000 nano at no
   * output and 3,250 per output token, at the ceiling.
   */
  const sibling = siblingCurve(
    { ...MODEL, pricing: tokenPricingFixture({ input: 1000n, output: 2600n }) },
    { inputTokens: 1000, inputChars: 0, persists: false },
    MONEY_SOLVE_CAP_TOKENS
  );

  it('floors the division, so a partial token is never bought', () => {
    expect(budgetBuysTokens(10_000_000n, [sibling], 0n)).toBe(2692);
  });

  it('is zero when the funding does not cover the fixed costs', () => {
    expect(budgetBuysTokens(500_000n, [sibling], 0n)).toBe(0);
  });

  it('sets the classifier reserve aside before solving', () => {
    // (10,000,000 − 2,600,000 − 1,250,000) / 3,250.
    expect(budgetBuysTokens(10_000_000n, [sibling], 2_600_000n)).toBe(1892);
  });

  it('solves siblings at one shared token count', () => {
    // (10,000,000 − 2 × 1,250,000) / (2 × 3,250).
    expect(budgetBuysTokens(10_000_000n, [sibling, sibling], 0n)).toBe(1153);
  });
});

describe('ceilingTokens — min(providerCap, contextHeadroom, budgetBuys)', () => {
  it('is bound by the provider cap when the money and the prompt leave more room', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 99_750, sharedTokens: 50_000 })).toBe(
      8000
    );
  });

  it('is bound by the context headroom when that is tightest', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 500, sharedTokens: 50_000 })).toBe(500);
  });

  it('is bound by what the money buys when that is tightest', () => {
    expect(ceilingTokens(MODEL, { contextHeadroomTokens: 99_750, sharedTokens: 1200 })).toBe(1200);
  });

  it('falls back to the context length when the catalog carries no provider cap', () => {
    const uncapped = { ...MODEL, providerCap: undefined };
    expect(ceilingTokens(uncapped, { contextHeadroomTokens: 200_000, sharedTokens: 500_000 })).toBe(
      100_000
    );
  });
});

describe('reasoningBudgetTokens — B(m, e), and e_min(m)', () => {
  const disableable: PriceableModel = {
    ...MODEL,
    modelId: modelId('vendor/disableable'),
    contextLength: 200_000,
    providerCap: 200_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  };
  const mandatory: PriceableModel = {
    ...MODEL,
    modelId: modelId('vendor/mandatory'),
    contextLength: 200_000,
    providerCap: 200_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };

  it('is the ladder budget for a named rung: Mid is 12,288 tokens', () => {
    expect(reasoningBudgetTokens(disableable, 'medium')).toBe(12_288);
  });

  it("is zero at e_min for a model that can disable reasoning — the 'off' rung", () => {
    expect(cheapestEffortOption(disableable)).toBe('off');
    expect(reasoningBudgetTokens(disableable, 'off')).toBe(0);
  });

  it("is the lowest offered rung's budget at e_min for a mandatory-reasoning model: 4,096", () => {
    expect(cheapestEffortOption(mandatory)).toBe('low');
    expect(reasoningBudgetTokens(mandatory, 'low')).toBe(4096);
  });

  it('has no cheapest option for a model that cannot reason at all', () => {
    expect(cheapestEffortOption(MODEL)).toBeUndefined();
  });

  it('reserves nothing for a model that cannot reason', () => {
    expect(reasoningBudgetTokens(MODEL, 'off')).toBe(0);
  });
});

describe('feasible(m, e) and eligible(m)', () => {
  const mandatory: PriceableModel = {
    ...MODEL,
    modelId: modelId('vendor/mandatory'),
    contextLength: 200_000,
    providerCap: 200_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };

  it('admits a level whose budget plus a minimum answer fits the ceiling', () => {
    expect(feasible(mandatory, 'low', 4096 + MINIMUM_OUTPUT_TOKENS)).toBe(true);
  });

  it('refuses a level one token short of the minimum answer', () => {
    expect(feasible(mandatory, 'low', 4096 + MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('grades eligibility on the resolved cheapest corner, never on an unreachable zero', () => {
    const support = dimensionSupportFor(EFFORT_DIMENSION, mandatory);
    expect(support.options.map((option) => option.optionId)).not.toContain('off');
    // A ceiling that fits a minimum answer but not the lowest rung beside it.
    expect(eligible(mandatory, MINIMUM_OUTPUT_TOKENS + 1)).toBe(false);
    expect(eligible(mandatory, 4096 + MINIMUM_OUTPUT_TOKENS)).toBe(true);
  });

  it('grades a non-reasoning model on the minimum answer alone', () => {
    expect(eligible(MODEL, MINIMUM_OUTPUT_TOKENS)).toBe(true);
    expect(eligible(MODEL, MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('requires the minimum answer alone when no rung applies', () => {
    expect(requiredCeilingTokens(MODEL)).toBe(MINIMUM_OUTPUT_TOKENS);
    expect(feasible(MODEL, undefined, MINIMUM_OUTPUT_TOKENS)).toBe(true);
    expect(feasible(MODEL, undefined, MINIMUM_OUTPUT_TOKENS - 1)).toBe(false);
  });

  it('states the same requirement the predicate tests, so a reason cannot re-add it', () => {
    expect(requiredCeilingTokens(mandatory, 'low')).toBe(4096 + MINIMUM_OUTPUT_TOKENS);
    expect(feasible(mandatory, 'low', requiredCeilingTokens(mandatory, 'low'))).toBe(true);
  });
});

describe('maxCallCostNanoUsd — cost(m, min(providerCap, contextHeadroom))', () => {
  it('prices the provider cap when the prompt leaves more room: 250 × 1,250 + 8,000 × 4,000 + framing', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasis(250, true))).toBe(
      312_500n + 32_000_000n + 192_000n
    );
  });

  it('prices the context headroom when that is tighter than the provider cap', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasis(99_000, true))).toBe(
      123_750_000n + 1000n * 4000n + 192_000n
    );
  });

  it('drops the storage term on a turn that does not persist', () => {
    expect(maxCallCostNanoUsd(MODEL, callCostBasis(250, false))).toBe(312_500n + 20_000_000n);
  });

  // A basis is a pure function of (prompt, persists), so two payers holding one
  // prompt on turns that both persist or both do not cannot produce differing
  // bases. "Carries no funding term" is therefore enforced by
  // the type, and the assertion that can fail is a type-level one. The payer
  // comparison this replaces lives in `turn-core.test.ts`, where funding IS an
  // input.
  it('cannot be handed a funding field at all', () => {
    const basis: CallCostBasis = {
      ...callCostBasis(250, true),
      // @ts-expect-error -- funding has no place in a basis. Add such a field and
      // this directive goes unused, which the typecheck reports.
      fundingNanoUsd: 10n ** 15n,
    };
    // Name-agnostic companion: `keyof` widens on ANY added field, so a funding
    // term spelled differently reddens here rather than slipping past the
    // directive above.
    const key: 'inputTokens' | 'persists' = 'inputTokens' as keyof CallCostBasis;
    expect(key).toBe('inputTokens');
    expect(maxCallCostNanoUsd(MODEL, basis)).toBe(312_500n + 32_000_000n + 192_000n);
  });

  it('is zero tokens wide once the prompt fills the window', () => {
    expect(maxCallCostTokens(MODEL, 100_000)).toBe(0);
  });
});

describe('outlier(m) — maxCallCost above OUTLIER_COST_MULTIPLE × the pool median', () => {
  /** Output rate alone varies, and every cap is 1,000 tokens, so maxCallCost is
   * exactly 1,000 × the output rate's ceiling: 1.25e6, 2.5e6, 3.75e6, 5e6 and
   * 1.25e8 nano. */
  const pool: readonly PriceableModel[] = [1000n, 2000n, 3000n, 4000n, 100_000n].map((rate) => ({
    modelId: modelId(`vendor/rate-${String(rate)}`),
    pricing: tokenPricingFixture({ input: 1n, output: rate }),
    contextLength: 100_000,
    providerCap: 1000,
    releasedAtMs: 0,
    reasoning: undefined,
  }));
  const basis = callCostBasis(0, false);

  it('takes the median over the whole priceable pool: 3,750,000 nano', () => {
    expect(medianMaxCallCostNanoUsd(pool, basis)).toBe(3_750_000n);
  });

  it('excludes only the model past 20 × that median', () => {
    expect([...outlierModelIds(pool, basis)]).toEqual(['vendor/rate-100000']);
  });

  it('never trims a tight distribution', () => {
    expect(outlierModelIds(pool.slice(0, 4), basis).size).toBe(0);
  });

  it('keeps a candidate exactly at the multiple: the test is strictly greater', () => {
    const atThreshold: PriceableModel = {
      ...pool[0]!,
      modelId: modelId('vendor/at-threshold'),
      pricing: tokenPricingFixture({ input: 1n, output: 3000n * 20n }),
    };
    expect(outlierModelIds([...pool.slice(0, 4), atThreshold], basis).size).toBe(0);
  });

  it('excludes a model made extreme by its CAPACITY rather than its rate', () => {
    const enormous: PriceableModel = {
      ...pool[1]!,
      modelId: modelId('vendor/enormous'),
      providerCap: 100_000,
      releasedAtMs: 0,
      contextLength: 1_000_000,
    };
    expect([...outlierModelIds([...pool.slice(0, 4), enormous], basis)]).toEqual([
      'vendor/enormous',
    ]);
  });

  it('drops a model the prompt leaves no room for from the pool rather than ranking it at zero', () => {
    const narrow: PriceableModel = {
      ...pool[0]!,
      modelId: modelId('vendor/narrow'),
      contextLength: 10,
    };
    expect(medianMaxCallCostNanoUsd([...pool, narrow], { ...basis, inputTokens: 100 })).toBe(
      medianMaxCallCostNanoUsd(pool, { ...basis, inputTokens: 100 })
    );
  });

  it('has no median, and therefore no exclusion, over an empty pool', () => {
    expect(medianMaxCallCostNanoUsd([], basis)).toBeUndefined();
    expect(outlierModelIds([], basis).size).toBe(0);
  });
});
